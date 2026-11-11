import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { connectDatabase, closeDatabase } from "./db.js";
import { Product, User } from "./models.js";

export async function seedDatabase() {
  //test
  if (!await User.exists({ username: "fpo" })) {
    await User.create({
      name: "FPO Officer",
      username: "fpo",
      passwordHash: await bcrypt.hash(process.env.DEMO_FPO_PASSWORD || "admin123", 10),
      role: "fpo",
      status: "approved"
    });
  }

  let farmer = await User.findOne({ phone: "9000000001" });
  if (!farmer) {
    farmer = await User.create({
      name: "Murugan",
      phone: "9000000001",
      passwordHash: await bcrypt.hash(process.env.DEMO_FARMER_PASSWORD || "1234", 10),
      role: "farmer",
      status: "approved",
      village: "Village A",
      fpoName: "Green Valley FPO",
      fpoMembershipNo: "FPO-101",
      acres: 2,
      crops: "Tomato, Brinjal",
      landRecord: "PATTA-1001"
    });
  }

  if (!await User.exists({ phone: "9000000002" })) {
    await User.create({
      name: "Lakshmi",
      phone: "9000000002",
      passwordHash: await bcrypt.hash("1234", 10),
      role: "farmer",
      status: "pending",
      village: "Village B",
      fpoName: "Green Valley FPO",
      fpoMembershipNo: "FPO-102",
      acres: 1,
      crops: "Spinach",
      landRecord: "PATTA-2002"
    });
  }

  if (!await Product.exists({ farmer: farmer._id })) {
    const daysFromNow = (days) => new Date(Date.now() + days * 86400000);
    await Product.insertMany([
      { farmer: farmer._id, name: "Tomato", price: 30, qty: 40, unit: "kg", harvestDate: daysFromNow(-1), sellBy: daysFromNow(5) },
      { farmer: farmer._id, name: "Brinjal", price: 40, qty: 25, unit: "kg", harvestDate: daysFromNow(-2), sellBy: daysFromNow(2) },
      { farmer: farmer._id, name: "Spinach", price: 20, qty: 15, unit: "bunch", harvestDate: daysFromNow(-1), sellBy: daysFromNow(1) }
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connectDatabase();
  await seedDatabase();
  console.log("FreshFarm demo data is ready.");
  await closeDatabase();
  process.exit(0);
}
