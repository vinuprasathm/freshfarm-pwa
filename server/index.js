import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowRoles, createToken, optionalAuth, publicUser, requireAuth } from "./auth.js";
import { closeDatabase, connectDatabase } from "./db.js";
import { CustomerRequest, Notification, Order, Product, User } from "./models.js";
import { seedDatabase } from "./seed.js";

process.env.NODE_ENV ||= "development";
const app = express();
const port = Number(process.env.PORT) || 5000;
const isAllowedLocalOrigin = (origin) => {
  if (!origin) return false;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "2mb" }));

const fail = (status, message) => Object.assign(new Error(message), { status });
const uploadDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "uploads");
await mkdir(uploadDirectory, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, done) => done(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, done) => file.mimetype.startsWith("image/") ? done(null, true) : done(fail(400, "Choose an image file."))
});
const validPhone = (value) => /^\d{10,15}$/.test(String(value || "").replace(/\D/g, ""));
const validId = (value) => mongoose.isValidObjectId(value);
const cleanPhone = (value) => String(value || "").replace(/\D/g, "");

function productDto(product) {
  const row = product.toObject ? product.toObject() : product;
  const daysLeft = Math.ceil((new Date(row.sellBy).getTime() - Date.now()) / 86400000);
  const discount = row.surplus || daysLeft <= 1 ? 0.25 : daysLeft <= 3 ? 0.1 : 0;
  return { ...row, discount, salePrice: Math.round(row.price * (1 - discount)) };
}

async function notifyUser(recipient, text, type = "info") {
  await Notification.create({ recipient, text, type });
}

async function notifyFarmers(text, type = "request") {
  const recipients = await User.find({ role: "farmer", status: "approved" }).select("_id").lean();
  if (recipients.length) await Notification.insertMany(recipients.map(({ _id }) => ({ recipient: _id, text, type })));
}

app.get("/api/health", (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.post("/api/auth/register", async (req, res) => {
  const { name, phone, password, village, fpoName, fpoMembershipNo, acres, crops, landRecord } = req.body;
  if (!name?.trim() || !validPhone(phone) || !password || password.length < 4 || !village?.trim()) {
    throw fail(400, "Enter your name, village, a valid phone, and a password of at least 4 characters.");
  }
  const user = await User.create({
    name: name.trim(), phone: cleanPhone(phone), passwordHash: await bcrypt.hash(password, 10), role: "farmer", status: "pending",
    village: village.trim(), fpoName: fpoName || "Green Valley FPO", fpoMembershipNo: fpoMembershipNo?.trim() || "",
    acres: Number(acres) || 0, crops: crops?.trim() || "", landRecord: landRecord?.trim() || ""
  });
  const officers = await User.find({ role: "fpo" }).select("_id").lean();
  if (officers.length) await Notification.insertMany(officers.map(({ _id }) => ({ recipient: _id, text: `Farmer registration: ${user.name}, ${user.village}`, type: "farmer-registration" })));
  res.status(201).json({ user: publicUser(user), message: "Registration submitted. An FPO officer must approve your account before you can sign in." });
});

app.post("/api/auth/login", async (req, res) => {
  const identifier = String(req.body.identifier || req.body.phone || req.body.username || "").trim();
  const user = await User.findOne({ $or: [{ phone: identifier }, { username: identifier.toLowerCase() }] });
  if (!user || !await bcrypt.compare(String(req.body.password || ""), user.passwordHash)) throw fail(401, "Incorrect phone / ID or password.");
  if (user.role === "farmer" && user.status !== "approved") {
    throw fail(403, user.status === "pending" ? "Your farmer account is waiting for FPO approval." : `Your account was rejected. ${user.rejectionReason || "Contact your FPO office."}`);
  }
  res.json({ token: createToken(user), user: publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get("/api/products", async (_req, res) => {
  const approved = await User.find({ role: "farmer", status: "approved" }).distinct("_id");
  const products = await Product.find({ farmer: { $in: approved }, qty: { $gt: 0 }, sellBy: { $gte: new Date() } })
    .populate("farmer", "name village fpoName").sort({ createdAt: -1 });
  res.json({ products: products.map(productDto) });
});

app.get("/api/quantity", async (_req, res) => {
  const soldRows = await Order.aggregate([
    { $match: { status: { $in: ["Delivered", "Resolved"] } } },
    { $group: { _id: "$product", sold: { $sum: "$qty" } } }
  ]);
  const sold = new Map(soldRows.map((row) => [row._id.toString(), row.sold]));
  const products = await Product.find({}).populate("farmer", "name").sort({ name: 1 });
  res.json({ quantity: products.map((product) => ({
    id: product._id.toString(), name: product.name, unit: product.unit, available: product.qty,
    sold: sold.get(product._id.toString()) || 0, farmer: product.farmer?.name || ""
  })) });
});

app.post("/api/products", requireAuth, allowRoles("farmer"), upload.single("photo"), async (req, res) => {
  const { name, price, qty, unit, harvestDate, sellBy } = req.body;
  if (req.user.status !== "approved") throw fail(403, "Only approved farmers can list produce.");
  if (!name?.trim() || !(Number(price) > 0) || !(Number(qty) > 0) || !sellBy) throw fail(400, "Enter the crop, a positive price and quantity, and a sell-by date.");
  const product = await Product.create({ farmer: req.user._id, name: name.trim(), price: Number(price), qty: Number(qty), unit: unit?.trim() || "kg", harvestDate: harvestDate || new Date(), sellBy, photoUrl: req.file ? `/uploads/${req.file.filename}` : "" });
  res.status(201).json({ product: productDto(product) });
});

app.patch("/api/products/:id", requireAuth, allowRoles("farmer"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid product ID.");
  const fields = {};
  for (const key of ["price", "qty", "sellBy", "surplus"]) if (req.body[key] !== undefined) fields[key] = req.body[key];
  const product = await Product.findOneAndUpdate({ _id: req.params.id, farmer: req.user._id }, { $set: fields }, { new: true, runValidators: true });
  if (!product) throw fail(404, "Product not found.");
  res.json({ product: productDto(product) });
});

app.post("/api/requests", async (req, res) => {
  const { customerName, phone, item, qty, unit, note } = req.body;
  if (!customerName?.trim() || !item?.trim() || !(Number(qty) > 0) || !validPhone(phone)) throw fail(400, "Enter your name, item, positive quantity, and a valid phone number.");
  const request = await CustomerRequest.create({ customerName: customerName.trim(), phone: cleanPhone(phone), item: item.trim(), qty: Number(qty), unit: unit?.trim() || "kg", note: note?.trim() || "" });
  await notifyFarmers(`Customer request: ${request.customerName} · ${request.qty} ${request.unit} ${request.item} · ${request.phone}`);
  res.status(201).json({ request, message: "Request sent. Approved farmers have been notified." });
});

app.get("/api/requests/open", requireAuth, allowRoles("farmer", "fpo"), async (_req, res) => {
  const requests = await CustomerRequest.find({ status: "open" }).sort({ createdAt: -1 }).limit(100);
  res.json({ requests });
});

app.patch("/api/requests/:id/status", requireAuth, allowRoles("farmer", "fpo"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid request ID.");
  const status = req.body.status === "fulfilled" ? "fulfilled" : "open";
  const request = await CustomerRequest.findOneAndUpdate({ _id: req.params.id, status: "open" }, { status }, { new: true });
  if (!request) throw fail(404, "Open request not found.");
  res.json({ request });
});

app.post("/api/orders", async (req, res) => {
  const { productId, customerName, customerPhone, address, landmark, qty, note } = req.body;
  const amount = Number(qty);
  if (!validId(productId) || !customerName?.trim() || !validPhone(customerPhone) || !address?.trim() || !Number.isInteger(amount) || amount < 1) {
    throw fail(400, "Enter your name, valid phone, delivery address, and a whole-number quantity.");
  }
  const product = await Product.findOneAndUpdate({ _id: productId, qty: { $gte: amount }, sellBy: { $gte: new Date() } }, { $inc: { qty: -amount } }, { new: true }).populate("farmer", "name village");
  if (!product || !product.farmer) throw fail(409, "This produce is no longer available in that quantity.");
  const farmer = await User.findOne({ _id: product.farmer._id, status: "approved", role: "farmer" });
  if (!farmer) {
    await Product.updateOne({ _id: product._id }, { $inc: { qty: amount } });
    throw fail(409, "This produce is not currently available.");
  }
  const unitPrice = productDto(product).salePrice;
  let order;
  try {
    order = await Order.create({ product: product._id, farmer: farmer._id, customerName: customerName.trim(), customerPhone: cleanPhone(customerPhone), address: address.trim(), landmark: landmark?.trim() || "", itemName: product.name, qty: amount, unit: product.unit, unitPrice, total: amount * unitPrice, customerNote: note?.trim() || "" });
  } catch (error) {
    await Product.updateOne({ _id: product._id }, { $inc: { qty: amount } });
    throw error;
  }
  await notifyUser(farmer._id, `New order: ${amount} ${product.unit} ${product.name} · ${customerName} · ${customerPhone}`, "order");
  res.status(201).json({ order, message: "Order placed." });
});

app.get("/api/orders/:id", optionalAuth, async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid order ID.");
  const order = await Order.findById(req.params.id).populate("farmer", "name village");
  if (!order) throw fail(404, "Order not found.");
  const isOwner = req.user?.role === "farmer" && order.farmer._id.equals(req.user._id);
  if (!isOwner && cleanPhone(req.query.phone) !== order.customerPhone) throw fail(404, "Order not found for that phone number.");
  res.json({ order });
});

app.post("/api/orders/:id/cancel", async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid order ID.");
  const order = await Order.findOne({ _id: req.params.id, customerPhone: cleanPhone(req.body.phone), status: "New" });
  if (!order) throw fail(404, "New order not found for that phone number.");
  order.status = "Cancelled";
  order.reason = req.body.reason || "Customer cancelled";
  await order.save();
  const product = await Product.findById(order.product);
  if (product && product.sellBy >= new Date()) await Product.updateOne({ _id: product._id }, { $inc: { qty: order.qty } });
  await notifyUser(order.farmer, `Order cancelled: ${order.itemName} × ${order.qty} · ${order.reason}`, "order");
  res.json({ order });
});

app.post("/api/orders/:id/issues", async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid order ID.");
  const order = await Order.findOne({ _id: req.params.id, customerPhone: cleanPhone(req.body.phone), status: "Delivered" });
  if (!order) throw fail(404, "Delivered order not found for that phone number.");
  if (!req.body.reason?.trim()) throw fail(400, "Choose a reason for the problem.");
  order.status = "Issue reported";
  order.reason = req.body.reason.trim();
  order.customerNote = req.body.note?.trim() || order.customerNote;
  await order.save();
  const officers = await User.find({ role: "fpo" }).select("_id").lean();
  if (officers.length) await Notification.insertMany(officers.map(({ _id }) => ({ recipient: _id, text: `Order issue: ${order.itemName} · ${order.reason}`, type: "issue" })));
  await notifyUser(order.farmer, `Customer reported a problem with ${order.itemName}: ${order.reason}`, "issue");
  res.json({ order });
});

app.get("/api/farmer/dashboard", requireAuth, allowRoles("farmer"), async (req, res) => {
  const [products, orders, requests] = await Promise.all([
    Product.find({ farmer: req.user._id }).sort({ createdAt: -1 }),
    Order.find({ farmer: req.user._id }).sort({ createdAt: -1 }),
    CustomerRequest.find({ status: "open" }).sort({ createdAt: -1 }).limit(100)
  ]);
  res.json({ products: products.map(productDto), orders, requests });
});

app.patch("/api/farmer/orders/:id", requireAuth, allowRoles("farmer"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid order ID.");
  const order = await Order.findOne({ _id: req.params.id, farmer: req.user._id });
  if (!order) throw fail(404, "Order not found.");
  const action = req.body.action;
  if (action === "start" && order.status === "New") {
    const eta = Number(req.body.etaMinutes);
    if (!(eta > 0)) throw fail(400, "Choose an expected delivery time.");
    order.status = "Out for delivery";
    order.etaMinutes = eta;
    order.etaAt = new Date(Date.now() + eta * 60000);
  } else if (action === "delivered" && order.status === "Out for delivery") {
    order.status = "Delivered";
  } else if (action === "failed" && ["New", "Out for delivery"].includes(order.status)) {
    if (!req.body.reason?.trim()) throw fail(400, "Choose a reason for delivery failure.");
    order.status = "Delivery failed";
    order.reason = req.body.reason.trim();
    if (order.reason !== "Produce got damaged") await Product.updateOne({ _id: order.product, sellBy: { $gte: new Date() } }, { $inc: { qty: order.qty } });
  } else {
    throw fail(409, "That delivery action is not available for this order.");
  }
  await order.save();
  res.json({ order });
});

app.get("/api/fpo/dashboard", requireAuth, allowRoles("fpo"), async (_req, res) => {
  const [pendingFarmers, approvedFarmers, issues, expiringProducts] = await Promise.all([
    User.find({ role: "farmer", status: "pending" }).select("-passwordHash").sort({ createdAt: 1 }),
    User.find({ role: "farmer", status: "approved" }).select("-passwordHash").sort({ name: 1 }),
    Order.find({ status: "Issue reported" }).populate("farmer", "name village").sort({ createdAt: -1 }),
    Product.find({ qty: { $gt: 0 }, sellBy: { $lte: new Date(Date.now() + 2 * 86400000) } }).populate("farmer", "name village").sort({ sellBy: 1 })
  ]);
  res.json({ pendingFarmers, approvedFarmers, issues, expiringProducts });
});

app.patch("/api/fpo/farmers/:id", requireAuth, allowRoles("fpo"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid farmer ID.");
  const status = req.body.status;
  if (!["approved", "rejected"].includes(status)) throw fail(400, "Choose approved or rejected.");
  const farmer = await User.findOneAndUpdate({ _id: req.params.id, role: "farmer", status: "pending" }, { status, rejectionReason: status === "rejected" ? String(req.body.reason || "Not approved").trim() : "" }, { new: true }).select("-passwordHash");
  if (!farmer) throw fail(404, "Pending farmer not found.");
  res.json({ farmer });
});

app.patch("/api/fpo/orders/:id/resolve", requireAuth, allowRoles("fpo"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid order ID.");
  if (!req.body.resolution?.trim()) throw fail(400, "Enter an FPO decision.");
  const order = await Order.findOneAndUpdate({ _id: req.params.id, status: "Issue reported" }, { status: "Resolved", resolution: req.body.resolution.trim() }, { new: true });
  if (!order) throw fail(404, "Reported order issue not found.");
  await notifyUser(order.farmer, `FPO decision for ${order.itemName}: ${order.resolution}`, "issue");
  res.json({ order });
});

app.patch("/api/fpo/products/:id/action", requireAuth, allowRoles("fpo"), async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, "Invalid product ID.");
  const product = await Product.findById(req.params.id);
  if (!product) throw fail(404, "Product not found.");
  if (req.body.action === "surplus") product.surplus = true;
  else if (["buy", "donate"].includes(req.body.action)) product.qty = 0;
  else throw fail(400, "Unknown stock action.");
  await product.save();
  res.json({ product: productDto(product) });
});

app.get("/api/notifications", requireAuth, async (req, res) => {
  const notifications = await Notification.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(30);
  res.json({ notifications, unread: notifications.filter((item) => !item.read).length });
});

app.patch("/api/notifications/read", requireAuth, async (req, res) => {
  await Notification.updateMany({ recipient: req.user._id, read: false }, { read: true });
  res.json({ ok: true });
});

app.use("/uploads", express.static(uploadDirectory));
app.use("/api", (_req, _res, next) => next(fail(404, "API route not found.")));
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
app.use(express.static(clientDist));
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(clientDist, "index.html"), (error) => { if (error) next(); });
});
app.use((error, _req, res, _next) => {
  const status = error.status || (error instanceof multer.MulterError ? 413 : error.code === 11000 ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ message: status === 500 ? "Server error. Check the API log." : error.message });
});

let server;
try {
  await connectDatabase();
  await seedDatabase();
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  server = app.listen(port, host, () => console.log(`FreshFarm API listening on http://${host}:${port}`));
} catch (error) {
  console.error("Could not start FreshFarm API:", error.message);
  process.exitCode = 1;
}

async function shutdown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
