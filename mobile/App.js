import React, { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const API_BASE = 'http://127.0.0.1:5000/api';
const STORAGE_KEY = 'freshfarm-mobile-token';

async function getStoredToken() {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

async function saveStoredToken(token) {
  try {
    if (token) {
      await AsyncStorage.setItem(STORAGE_KEY, token);
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    // ignore
  }
}

function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [products, setProducts] = useState([]);
  const [quantityRows, setQuantityRows] = useState([]);
  const [workspace, setWorkspace] = useState({ products: [], orders: [], requests: [], pendingFarmers: [], approvedFarmers: [], issues: [], expiringProducts: [] });
  const [notice, setNotice] = useState('');
  const [portal, setPortal] = useState(null);
  const [activeTab, setActiveTab] = useState('home');
  const [loading, setLoading] = useState(true);

  async function request(path, options = {}, authToken = token) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(options.headers || {}),
      },
    });

    const rawText = await response.text();
    let payload = rawText;
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      payload = rawText;
    }

    if (!response.ok) {
      throw new Error(payload?.message || 'Request failed');
    }

    return payload;
  }

  async function loadProducts() {
    const [productResult, quantityResult] = await Promise.all([
      request('/products'),
      request('/quantity'),
    ]);
    setProducts(productResult.products || []);
    setQuantityRows(quantityResult.quantity || []);
  }

  async function loadWorkspace(currentUser = user) {
    if (!currentUser) {
      setWorkspace({ products: [], orders: [], requests: [], pendingFarmers: [], approvedFarmers: [], issues: [], expiringProducts: [] });
      return;
    }

    const role = currentUser.role;
    if (role === 'farmer') {
      const data = await request('/farmer/dashboard');
      setWorkspace({
        products: data.products || [],
        orders: data.orders || [],
        requests: data.requests || [],
        pendingFarmers: [],
        approvedFarmers: [],
        issues: [],
        expiringProducts: [],
      });
      return;
    }

    if (role === 'fpo') {
      const data = await request('/fpo/dashboard');
      setWorkspace({
        products: [],
        orders: [],
        requests: [],
        pendingFarmers: data.pendingFarmers || [],
        approvedFarmers: data.approvedFarmers || [],
        issues: data.issues || [],
        expiringProducts: data.expiringProducts || [],
      });
      return;
    }

    setWorkspace({ products: [], orders: [], requests: [], pendingFarmers: [], approvedFarmers: [], issues: [], expiringProducts: [] });
  }

  useEffect(() => {
    async function bootstrap() {
      const savedToken = await getStoredToken();
      setToken(savedToken);
      if (savedToken) {
        try {
          const result = await request('/auth/me', {}, savedToken);
          const nextUser = result.user;
          setUser(nextUser);
          setPortal(nextUser.role);
        } catch (_error) {
          await saveStoredToken(null);
          setToken(null);
        }
      }

      try {
        await loadProducts();
      } catch (error) {
        setNotice(error.message);
      }

      setLoading(false);
    }

    bootstrap();
  }, []);

  useEffect(() => {
    if (!user) return;
    loadWorkspace(user).catch((error) => setNotice(error.message));
  }, [user]);

  async function login(values) {
    const result = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(values),
    });

    await saveStoredToken(result.token);
    setToken(result.token);
    setUser(result.user);
    setPortal(result.user.role);
    setNotice(`Welcome, ${result.user.name}.`);
    await loadWorkspace(result.user);
  }

  async function register(values) {
    const result = await request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(values),
    });
    setNotice(result.message);
  }

  async function logout() {
    await saveStoredToken(null);
    setToken(null);
    setUser(null);
    setPortal(null);
    setNotice('You have signed out.');
  }

  async function refreshData() {
    try {
      await Promise.all([loadProducts(), loadWorkspace(user)]);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function placeOrder(product, qty, checkout) {
    try {
      const payload = {
        productId: product._id,
        qty: Number(qty || 1),
        customerName: checkout.customerName,
        customerPhone: checkout.customerPhone,
        address: checkout.address,
        landmark: checkout.landmark,
      };
      const result = await request('/orders', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setNotice(`Order placed. Order number: ${result.order._id}`);
      await loadProducts();
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    }
  }

  async function placeCartOrder(cart, checkout) {
    if (!cart || Object.keys(cart).length === 0) {
      setNotice('Your cart is empty.');
      return;
    }

    if (!checkout.customerName || !checkout.customerPhone || !checkout.address) {
      setNotice('Please complete your name, phone, and delivery address before placing the order.');
      return;
    }

    const entries = Object.values(cart);
    let created = 0;

    for (const item of entries) {
      if (!item?.product || Number(item.qty) <= 0) continue;
      const result = await placeOrder(item.product, Number(item.qty), checkout);
      if (result) created += 1;
    }

    if (created > 0) {
      setNotice(`Placed ${created} order${created > 1 ? 's' : ''}.`);
    }
  }

  async function submitRequest(form) {
    try {
      const result = await request('/requests', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setNotice(result.message);
      if (user?.role === 'farmer') {
        await loadWorkspace(user);
      }
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    }
  }

  async function addFarmerProduct(form) {
    try {
      const result = await request('/products', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setNotice('Produce added to your listings.');
      await loadWorkspace(user);
      await loadProducts();
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    }
  }

  async function farmeOrderAction(orderId, action, details = {}) {
    try {
      const payload = { action, ...details };
      await request(`/farmer/orders/${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setNotice(action === 'start' ? 'Delivery started.' : 'Order status updated.');
      await loadWorkspace(user);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function fpoDecision({ farmerId, status, reason = '' }) {
    try {
      await request(`/fpo/farmers/${farmerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason }),
      });
      setNotice(`Farmer ${status}.`);
      await loadWorkspace(user);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function resolveIssue(orderId, resolution) {
    try {
      await request(`/fpo/orders/${orderId}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({ resolution }),
      });
      setNotice('Issue resolved.');
      await loadWorkspace(user);
    } catch (error) {
      setNotice(error.message);
    }
  }

  function openPortal(nextPortal) {
    setPortal(nextPortal);
    setNotice('');
  }

  const homeTabs = [
    { key: 'home', label: 'Home' },
    { key: 'about', label: 'About' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'market', label: 'Market' },
    { key: 'requests', label: 'Requests' },
  ];

  if (loading) {
    return (
      <SafeAreaView style={styles.centered}><ActivityIndicator size="large" color="#17553c" /></SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrapper}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>FreshFarm</Text>
            <Text style={styles.brandSub}>Direct from growers</Text>
          </View>
          {user ? (
            <TouchableOpacity style={styles.secondaryButton} onPress={logout}>
              <Text style={styles.secondaryButtonText}>Sign out</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.primaryButton} onPress={() => openPortal('farmer')}>
              <Text style={styles.primaryButtonText}>Sign in</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.tabRow}>
            {homeTabs.map((tab) => (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, activeTab === tab.key && styles.tabActive]}
                onPress={() => {
                  setActiveTab(tab.key);
                  setPortal(null);
                }}
              >
                <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {notice ? <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View> : null}

          {portal ? (
            <PortalScreen
              portal={portal}
              user={user}
              products={products}
              workspace={workspace}
              onLogin={login}
              onRegister={register}
              onBack={() => setPortal(null)}
              placeOrder={placeOrder}
              placeCartOrder={placeCartOrder}
              submitRequest={submitRequest}
              addFarmerProduct={addFarmerProduct}
              updateOrder={farmeOrderAction}
              approveFarmer={fpoDecision}
              resolveIssue={resolveIssue}
            />
          ) : (
            <>
              {activeTab === 'home' && <HomeScreen openPortal={openPortal} />}
              {activeTab === 'about' && <AboutScreen />}
              {activeTab === 'quantity' && <QuantityScreen rows={quantityRows} />}
              {activeTab === 'market' && <MarketScreen products={products} />}
              {activeTab === 'requests' && <RequestsScreen user={user} submitRequest={submitRequest} />}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function HomeScreen({ openPortal }) {
  return (
    <View style={styles.stack}>
      <View style={styles.heroCard}>
        <Text style={styles.eyebrow}>FARM TO FAMILY</Text>
        <Text style={styles.heroTitle}>Good food starts with a fair connection.</Text>
        <Text style={styles.heroText}>Discover local harvests from verified farmers and order directly from the source.</Text>
      </View>

      <View style={styles.cardGrid}>
        <TouchableOpacity style={[styles.roleCard, styles.customerCard]} onPress={() => openPortal('customer')}>
          <Text style={styles.roleIndex}>01 / MARKET</Text>
          <Text style={styles.roleTitle}>Shop produce</Text>
          <Text style={styles.roleDescription}>Browse seasonal crops and place an order.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.roleCard, styles.farmerCard]} onPress={() => openPortal('farmer')}>
          <Text style={styles.roleIndex}>02 / GROWER</Text>
          <Text style={styles.roleTitle}>Farmer workspace</Text>
          <Text style={styles.roleDescription}>Manage listings and delivery updates.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.roleCard, styles.fpoCard]} onPress={() => openPortal('fpo')}>
          <Text style={styles.roleIndex}>03 / FPO</Text>
          <Text style={styles.roleTitle}>FPO workspace</Text>
          <Text style={styles.roleDescription}>Review growers and resolve order issues.</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function AboutScreen() {
  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>OUR PURPOSE</Text>
      <Text style={styles.title}>About FreshFarm</Text>
      <Text style={styles.bodyText}>FreshFarm connects local farmers and customers without extra middlemen. It keeps produce local, transparent, and fair.</Text>
      <View style={styles.listStack}>
        <View style={styles.featureBox}><Text style={styles.featureNumber}>01</Text><Text style={styles.featureTitle}>For farmers</Text><Text style={styles.bodyText}>List harvests with transparent pricing and receive direct orders.</Text></View>
        <View style={styles.featureBox}><Text style={styles.featureNumber}>02</Text><Text style={styles.featureTitle}>For customers</Text><Text style={styles.bodyText}>Find fresh produce from nearby growers and request custom deliveries.</Text></View>
        <View style={styles.featureBox}><Text style={styles.featureNumber}>03</Text><Text style={styles.featureTitle}>For FPOs</Text><Text style={styles.bodyText}>Support approvals, track order issues, and build trusted local logistics.</Text></View>
      </View>
    </View>
  );
}

function QuantityScreen({ rows }) {
  const total = rows.reduce((sum, item) => sum + Number(item.sold || 0), 0);
  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>MARKET ACTIVITY</Text>
      <Text style={styles.title}>Quantity sold</Text>
      <Text style={styles.metric}>Total delivered: {total}</Text>
      {rows.length === 0 ? <Text style={styles.bodyText}>No sold quantities have been recorded yet.</Text> : rows.map((row) => (
        <View key={row.id} style={styles.rowItem}>
          <Text style={styles.bold}>{row.name}</Text>
          <Text>{row.farmer}</Text>
          <Text>Sold: {row.sold} {row.unit}</Text>
          <Text>Available: {row.available} {row.unit}</Text>
        </View>
      ))}
    </View>
  );
}

function MarketScreen({ products }) {
  const unique = products.filter((product, index, list) => list.findIndex((entry) => entry.name === product.name && entry.unit === product.unit) === index);

  if (!unique.length) {
    return <View style={styles.panel}><Text style={styles.title}>No prices available</Text><Text style={styles.bodyText}>Price samples will appear as farmers list produce.</Text></View>;
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>PRICE BOARD</Text>
      <Text style={styles.title}>Market live</Text>
      <View style={styles.marketGrid}>
        {unique.map((product) => (
          <View key={product._id || product.name} style={styles.marketCard}>
            <Text style={styles.marketName}>{product.name}</Text>
            <Text>{product.farmer?.name || 'Verified grower'} · {product.unit}</Text>
            <Text style={styles.marketPrice}>₹{Math.round(product.salePrice || 0)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function RequestsScreen({ user, submitRequest }) {
  const [form, setForm] = useState({ customerName: '', phone: '', item: '', qty: '1', unit: 'kg', note: '' });

  async function handleSubmit() {
    if (!form.customerName || !form.phone || !form.item || Number(form.qty) <= 0) {
      Alert.alert('Missing details', 'Please complete all required fields.');
      return;
    }
    await submitRequest(form);
    setForm({ customerName: '', phone: '', item: '', qty: '1', unit: 'kg', note: '' });
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>WANTED BY CUSTOMERS</Text>
      <Text style={styles.title}>Request produce</Text>
      <TextInput style={styles.input} placeholder="Customer name" value={form.customerName} onChangeText={(value) => setForm({ ...form, customerName: value })} />
      <TextInput style={styles.input} placeholder="Phone" keyboardType="phone-pad" value={form.phone} onChangeText={(value) => setForm({ ...form, phone: value })} />
      <TextInput style={styles.input} placeholder="Item or crop" value={form.item} onChangeText={(value) => setForm({ ...form, item: value })} />
      <TextInput style={styles.input} placeholder="Quantity" keyboardType="numeric" value={form.qty} onChangeText={(value) => setForm({ ...form, qty: value })} />
      <TextInput style={styles.input} placeholder="Note (optional)" value={form.note} onChangeText={(value) => setForm({ ...form, note: value })} />
      <TouchableOpacity style={styles.primaryButtonWide} onPress={handleSubmit}>
        <Text style={styles.primaryButtonText}>Submit request</Text>
      </TouchableOpacity>
      {user?.role === 'farmer' ? <Text style={styles.bodyText}>Farmer dashboard will show incoming customer requests.</Text> : <Text style={styles.bodyText}>Sign in to a farmer or FPO workspace to view requests.</Text>}
    </View>
  );
}

function PortalScreen({ portal, user, products, workspace, onLogin, onRegister, onBack, placeOrder, placeCartOrder, submitRequest, addFarmerProduct, updateOrder, approveFarmer, resolveIssue }) {
  const [checkout, setCheckout] = useState({ customerName: '', customerPhone: '', address: '', landmark: '' });

  if (portal === 'customer') {
    return <CustomerPortal products={products} checkout={checkout} setCheckout={setCheckout} placeOrder={placeOrder} placeCartOrder={placeCartOrder} onBack={onBack} />;
  }

  if (!user || user.role !== portal) {
    return <AuthPanel role={portal} onLogin={onLogin} onRegister={onRegister} onBack={onBack} />;
  }

  if (portal === 'farmer') {
    return <FarmerPortal workspace={workspace} addFarmerProduct={addFarmerProduct} updateOrder={updateOrder} onBack={onBack} />;
  }

  if (portal === 'fpo') {
    return <FpoPortal workspace={workspace} approveFarmer={approveFarmer} resolveIssue={resolveIssue} onBack={onBack} />;
  }

  return null;
}

function CustomerPortal({ products, checkout, setCheckout, placeOrder, placeCartOrder, onBack }) {
  const [qtyMap, setQtyMap] = useState({});
  const [cart, setCart] = useState({});

  function addToCart(product, quantity) {
    const requestedQty = Math.max(1, Number(quantity) || 1);
    setCart((current) => {
      const existing = current[product._id] || { product, qty: 0 };
      return {
        ...current,
        [product._id]: {
          product,
          qty: Math.min(Number(product.qty || 0), Number(existing.qty) + requestedQty),
        },
      };
    });
  }

  function removeFromCart(productId) {
    setCart((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
  }

  const cartItems = Object.values(cart);
  const cartTotal = cartItems.reduce((sum, item) => sum + Number(item.product.salePrice || 0) * Number(item.qty || 0), 0);

  return (
    <View style={styles.panel}>
      <TouchableOpacity onPress={onBack} style={styles.linkButton}><Text style={styles.linkButtonText}>← Back to FreshFarm</Text></TouchableOpacity>
      <Text style={styles.eyebrow}>THE FARMERS' MARKET</Text>
      <Text style={styles.title}>Fresh from nearby farms</Text>
      <View style={styles.checkoutBox}>
        <TextInput style={styles.input} placeholder="Your name" value={checkout.customerName} onChangeText={(value) => setCheckout({ ...checkout, customerName: value })} />
        <TextInput style={styles.input} placeholder="Phone" keyboardType="phone-pad" value={checkout.customerPhone} onChangeText={(value) => setCheckout({ ...checkout, customerPhone: value })} />
        <TextInput style={styles.input} placeholder="Delivery address" value={checkout.address} onChangeText={(value) => setCheckout({ ...checkout, address: value })} />
        <TextInput style={styles.input} placeholder="Landmark (optional)" value={checkout.landmark} onChangeText={(value) => setCheckout({ ...checkout, landmark: value })} />
      </View>

      <View style={styles.cartSummary}>
        <Text style={styles.subtitle}>Cart ({cartItems.length})</Text>
        {cartItems.length === 0 ? <Text style={styles.bodyText}>No items added yet.</Text> : (
          <>
            {cartItems.map((item) => (
              <View key={item.product._id} style={styles.cartRow}>
                <Text style={styles.bold}>{item.product.name} × {item.qty}</Text>
                <Text style={styles.bodyText}>₹{Math.round((item.product.salePrice || 0) * (item.qty || 0))}</Text>
                <TouchableOpacity style={styles.secondaryButtonSmall} onPress={() => removeFromCart(item.product._id)}>
                  <Text style={styles.secondaryButtonText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
            <Text style={styles.price}>Cart total: ₹{Math.round(cartTotal)}</Text>
            <TouchableOpacity style={styles.primaryButtonWide} onPress={() => placeCartOrder(cart, checkout)}>
              <Text style={styles.primaryButtonText}>Place cart order</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {products.length === 0 ? <Text style={styles.bodyText}>No produce is available right now.</Text> : products.map((product) => {
        const quantity = Number(qtyMap[product._id] || 1);
        return (
          <View key={product._id || product.name} style={styles.productCard}>
            <Image source={{ uri: product.photoUrl ? `http://127.0.0.1:5000${product.photoUrl}` : 'https://images.unsplash.com/...'} } style={styles.productImage} />
            <View style={styles.productMeta}>
              <Text style={styles.productName}>{product.name}</Text>
              <Text style={styles.bodyText}>{product.farmer?.name || 'Verified farmer'} · {product.qty} {product.unit} available</Text>
              <Text style={styles.price}>₹{Math.round(product.salePrice || 0)} / {product.unit}</Text>
              <View style={styles.qtyRow}>
                <TextInput
                  style={styles.smallInput}
                  keyboardType="numeric"
                  value={String(quantity)}
                  onChangeText={(value) => setQtyMap({ ...qtyMap, [product._id]: value })}
                />
                <TouchableOpacity style={styles.primaryButtonSmall} onPress={() => addToCart(product, quantity)}>
                  <Text style={styles.primaryButtonText}>Add to cart</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButtonSmall} onPress={() => placeOrder(product, quantity || 1, checkout)}>
                  <Text style={styles.secondaryButtonText}>Order now</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function FarmerPortal({ workspace, addFarmerProduct, updateOrder, onBack }) {
  const [form, setForm] = useState({ name: '', price: '0', qty: '1', unit: 'kg', sellBy: '' });

  async function handleAdd() {
    if (!form.name || Number(form.price) <= 0 || Number(form.qty) <= 0 || !form.sellBy) {
      Alert.alert('Missing data', 'Enter a crop name, price, quantity, and sell-by date.');
      return;
    }
    await addFarmerProduct({ ...form, price: Number(form.price), qty: Number(form.qty), sellBy: form.sellBy });
    setForm({ name: '', price: '0', qty: '1', unit: 'kg', sellBy: '' });
  }

  return (
    <View style={styles.panel}>
      <TouchableOpacity onPress={onBack} style={styles.linkButton}><Text style={styles.linkButtonText}>← Back to FreshFarm</Text></TouchableOpacity>
      <Text style={styles.eyebrow}>FARMER WORKSPACE</Text>
      <Text style={styles.title}>Your produce</Text>
      <View style={styles.checkoutBox}>
        <TextInput style={styles.input} placeholder="Crop name" value={form.name} onChangeText={(value) => setForm({ ...form, name: value })} />
        <TextInput style={styles.input} placeholder="Price" keyboardType="numeric" value={form.price} onChangeText={(value) => setForm({ ...form, price: value })} />
        <TextInput style={styles.input} placeholder="Quantity" keyboardType="numeric" value={form.qty} onChangeText={(value) => setForm({ ...form, qty: value })} />
        <TextInput style={styles.input} placeholder="Unit (kg, bunch, bag)" value={form.unit} onChangeText={(value) => setForm({ ...form, unit: value })} />
        <TextInput style={styles.input} placeholder="Sell by (YYYY-MM-DD)" value={form.sellBy} onChangeText={(value) => setForm({ ...form, sellBy: value })} />
        <TouchableOpacity style={styles.primaryButtonWide} onPress={handleAdd}><Text style={styles.primaryButtonText}>Add product</Text></TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>Latest orders</Text>
      {workspace.orders?.length ? workspace.orders.map((order) => (
        <View key={order._id} style={styles.orderCard}>
          <Text style={styles.bold}>{order.itemName} · {order.qty} {order.unit}</Text>
          <Text>{order.customerName} · {order.customerPhone}</Text>
          <Text>{order.status}</Text>
          <View style={styles.inlineActions}>
            <TouchableOpacity style={styles.secondaryButtonSmall} onPress={() => updateOrder(order._id, 'start', { etaMinutes: 60 })}><Text style={styles.secondaryButtonText}>Start</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButtonSmall} onPress={() => updateOrder(order._id, 'delivered')}><Text style={styles.secondaryButtonText}>Delivered</Text></TouchableOpacity>
          </View>
        </View>
      )) : <Text style={styles.bodyText}>No orders yet.</Text>}
    </View>
  );
}

function FpoPortal({ workspace, approveFarmer, resolveIssue, onBack }) {
  const [decision, setDecision] = useState({});

  return (
    <View style={styles.panel}>
      <TouchableOpacity onPress={onBack} style={styles.linkButton}><Text style={styles.linkButtonText}>← Back to FreshFarm</Text></TouchableOpacity>
      <Text style={styles.eyebrow}>FPO WORKSPACE</Text>
      <Text style={styles.title}>Farmer oversight</Text>

      <Text style={styles.subtitle}>Pending registrations</Text>
      {workspace.pendingFarmers?.length ? workspace.pendingFarmers.map((farmer) => (
        <View key={farmer._id} style={styles.orderCard}>
          <Text style={styles.bold}>{farmer.name}</Text>
          <Text>{farmer.village} · {farmer.phone}</Text>
          <View style={styles.inlineActions}>
            <TouchableOpacity style={styles.primaryButtonSmall} onPress={() => approveFarmer({ farmerId: farmer._id, status: 'approved' })}><Text style={styles.primaryButtonText}>Approve</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButtonSmall} onPress={() => approveFarmer({ farmerId: farmer._id, status: 'rejected', reason: 'Not approved' })}><Text style={styles.secondaryButtonText}>Reject</Text></TouchableOpacity>
          </View>
        </View>
      )) : <Text style={styles.bodyText}>No pending farmer registrations.</Text>}

      <Text style={styles.subtitle}>Order issues</Text>
      {workspace.issues?.length ? workspace.issues.map((item) => (
        <View key={item._id} style={styles.orderCard}>
          <Text style={styles.bold}>{item.itemName}</Text>
          <Text>{item.reason}</Text>
          <TextInput
            style={styles.input}
            placeholder="FPO resolution"
            value={decision[item._id] || ''}
            onChangeText={(value) => setDecision({ ...decision, [item._id]: value })}
          />
          <TouchableOpacity style={styles.primaryButtonWide} onPress={() => resolveIssue(item._id, decision[item._id] || 'Resolved by FPO')}>
            <Text style={styles.primaryButtonText}>Resolve</Text>
          </TouchableOpacity>
        </View>
      )) : <Text style={styles.bodyText}>No open issue reports.</Text>}
    </View>
  );
}

function AuthPanel({ role, onLogin, onRegister, onBack }) {
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState({
    identifier: role === 'fpo' ? 'fpo' : '',
    password: '',
    name: '',
    phone: '',
    village: '',
    fpoName: 'Green Valley FPO',
    fpoMembershipNo: '',
    acres: '',
    crops: '',
    landRecord: '',
  });

  async function handleSubmit() {
    const payload = registering ? {
      name: form.name,
      phone: form.phone,
      village: form.village,
      fpoName: form.fpoName,
      fpoMembershipNo: form.fpoMembershipNo,
      acres: form.acres,
      crops: form.crops,
      landRecord: form.landRecord,
      password: form.password,
    } : {
      identifier: form.identifier,
      password: form.password,
    };

    if (registering) {
      await onRegister(payload);
      return;
    }

    await onLogin(payload);
  }

  return (
    <View style={styles.panel}>
      {onBack ? <TouchableOpacity onPress={onBack} style={styles.linkButton}><Text style={styles.linkButtonText}>← Back to FreshFarm</Text></TouchableOpacity> : null}
      <Text style={styles.eyebrow}>{role === 'fpo' ? 'FPO workspace' : 'Farmer workspace'}</Text>
      <Text style={styles.title}>{registering ? 'Farmer registration' : 'Sign in'}</Text>

      {registering ? (
        <>
          <TextInput style={styles.input} placeholder="Full name" value={form.name} onChangeText={(value) => setForm({ ...form, name: value })} />
          <TextInput style={styles.input} placeholder="Phone" keyboardType="phone-pad" value={form.phone} onChangeText={(value) => setForm({ ...form, phone: value })} />
          <TextInput style={styles.input} placeholder="Village" value={form.village} onChangeText={(value) => setForm({ ...form, village: value })} />
          <TextInput style={styles.input} placeholder="Password" secureTextEntry value={form.password} onChangeText={(value) => setForm({ ...form, password: value })} />
          <TextInput style={styles.input} placeholder="FPO" value={form.fpoName} onChangeText={(value) => setForm({ ...form, fpoName: value })} />
          <TextInput style={styles.input} placeholder="FPO membership number" value={form.fpoMembershipNo} onChangeText={(value) => setForm({ ...form, fpoMembershipNo: value })} />
          <TextInput style={styles.input} placeholder="Land size (acres)" keyboardType="numeric" value={form.acres} onChangeText={(value) => setForm({ ...form, acres: value })} />
          <TextInput style={styles.input} placeholder="Crops grown" value={form.crops} onChangeText={(value) => setForm({ ...form, crops: value })} />
          <TextInput style={styles.input} placeholder="Land record number" value={form.landRecord} onChangeText={(value) => setForm({ ...form, landRecord: value })} />
        </>
      ) : (
        <>
          <TextInput style={styles.input} placeholder={role === 'fpo' ? 'FPO user ID' : 'Farmer phone'} value={form.identifier} onChangeText={(value) => setForm({ ...form, identifier: value })} />
          <TextInput style={styles.input} placeholder="Password" secureTextEntry value={form.password} onChangeText={(value) => setForm({ ...form, password: value })} />
        </>
      )}
      <TouchableOpacity style={styles.primaryButtonWide} onPress={handleSubmit}><Text style={styles.primaryButtonText}>{registering ? 'Submit for FPO approval' : 'Sign in'}</Text></TouchableOpacity>
      {role === 'farmer' ? (
        <TouchableOpacity onPress={() => setRegistering(!registering)}>
          <Text style={styles.linkButtonText}>{registering ? 'Already registered? Sign in' : 'New farmer? Register'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f2f5ee' },
  wrapper: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2f5ee' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#d6e0d6' },
  brand: { fontSize: 28, fontWeight: '700', color: '#173b2b' },
  brandSub: { color: '#5d736a', fontSize: 12, letterSpacing: 1.3 },
  content: { paddingHorizontal: 16, paddingVertical: 12, paddingBottom: 40 },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tab: { paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#edf3ed', borderRadius: 8, borderWidth: 1, borderColor: '#dde9dd' },
  tabActive: { backgroundColor: '#17553c' },
  tabText: { fontSize: 12, color: '#173b2b', fontWeight: '700' },
  tabTextActive: { color: '#fff' },
  notice: { backgroundColor: '#eaf6ea', borderColor: '#cfe7d3', borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  noticeText: { color: '#173b2b', fontWeight: '600' },
  stack: { gap: 16 },
  heroCard: { backgroundColor: '#17553c', borderRadius: 20, padding: 22 },
  eyebrow: { fontSize: 10, letterSpacing: 1.3, color: '#8a6c2e', fontWeight: '700' },
  heroTitle: { color: '#fff', fontSize: 34, fontWeight: '700', marginTop: 10 },
  heroText: { color: '#e6efe8', marginTop: 10, fontSize: 15 },
  cardGrid: { gap: 12 },
  roleCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18, borderWidth: 1, borderColor: '#dfe9df', minHeight: 140 },
  customerCard: { backgroundColor: '#f1f7ef' },
  farmerCard: { backgroundColor: '#eef5f1' },
  fpoCard: { backgroundColor: '#f7f1e4' },
  roleIndex: { fontSize: 12, letterSpacing: 1.2, color: '#6f7b72', fontWeight: '700' },
  roleTitle: { fontSize: 24, fontWeight: '700', color: '#173b2b', marginTop: 10 },
  roleDescription: { marginTop: 8, color: '#50675d', fontSize: 14 },
  panel: { backgroundColor: '#fff', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#dfe8df', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '700', color: '#173b2b', marginBottom: 12 },
  subtitle: { fontSize: 18, fontWeight: '700', color: '#173b2b', marginTop: 10, marginBottom: 8 },
  bodyText: { color: '#536b62', fontSize: 14, lineHeight: 20 },
  metric: { fontSize: 18, fontWeight: '700', color: '#17553c', marginBottom: 12 },
  rowItem: { paddingVertical: 12, borderBottomWidth: 1, borderColor: '#edf1ee' },
  bold: { color: '#173b2b', fontWeight: '700' },
  marketGrid: { gap: 12, marginTop: 12 },
  marketCard: { backgroundColor: '#f7faf7', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e2e8e2' },
  marketName: { fontSize: 20, fontWeight: '700', color: '#173b2b' },
  marketPrice: { marginTop: 10, fontSize: 24, fontWeight: '700', color: '#17553c' },
  input: { backgroundColor: '#f7faf7', borderWidth: 1, borderColor: '#dae4db', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 10, fontSize: 15 },
  smallInput: { width: 80, backgroundColor: '#f7faf7', borderWidth: 1, borderColor: '#dae4db', borderRadius: 10, padding: 10, marginRight: 10 },
  primaryButton: { backgroundColor: '#17553c', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  primaryButtonText: { color: '#fff', textAlign: 'center', fontWeight: '700' },
  primaryButtonWide: { backgroundColor: '#17553c', borderRadius: 10, paddingVertical: 12, marginTop: 6, marginBottom: 10 },
  primaryButtonSmall: { backgroundColor: '#17553c', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
  secondaryButton: { backgroundColor: '#edf3ed', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  secondaryButtonText: { color: '#173b2b', textAlign: 'center', fontWeight: '700' },
  secondaryButtonSmall: { backgroundColor: '#edf3ed', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  linkButton: { marginBottom: 12 },
  linkButtonText: { color: '#17553c', fontWeight: '700' },
  checkoutBox: { marginTop: 8, marginBottom: 16 },
  productCard: { flexDirection: 'row', gap: 12, borderWidth: 1, borderColor: '#e5ebea', borderRadius: 14, padding: 12, marginBottom: 12, backgroundColor: '#f9fbf9' },
  productImage: { width: 96, height: 96, borderRadius: 12, backgroundColor: '#dde7df' },
  productMeta: { flex: 1 },
  productName: { fontSize: 20, fontWeight: '700', color: '#173b2b' },
  price: { fontSize: 22, fontWeight: '700', color: '#17553c', marginTop: 6 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  cartSummary: { backgroundColor: '#f7faf7', borderWidth: 1, borderColor: '#dfe7df', borderRadius: 14, padding: 12, marginBottom: 14 },
  cartRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 },
  orderCard: { backgroundColor: '#f7faf7', borderWidth: 1, borderColor: '#e4ece5', borderRadius: 12, padding: 12, marginBottom: 10 },
  inlineActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  featureBox: { backgroundColor: '#f7faf7', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e1eae2', marginTop: 10 },
  featureNumber: { fontSize: 16, fontWeight: '700', color: '#17553c' },
  featureTitle: { fontSize: 18, fontWeight: '700', color: '#173b2b', marginTop: 4, marginBottom: 4 },
  listStack: { marginTop: 8 },
});

export default App;
