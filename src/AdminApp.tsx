import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

type JsonObject = Record<string, any>;
type Section = 'dashboard' | 'orders' | 'products' | 'content';

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Erreur serveur (${response.status})`);
  return result;
}

function money(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toLocaleString('fr-FR')} XOF` : '0 XOF';
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-white/10 bg-[#14141A] p-5 shadow-lg">
    <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-[#D4889E]">{title}</h2>
    {children}
  </section>;
}

export default function AdminApp() {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>('dashboard');
  const [products, setProducts] = useState<JsonObject[]>([]);
  const [orders, setOrders] = useState<JsonObject[]>([]);
  const [content, setContent] = useState<JsonObject>({});
  const [productId, setProductId] = useState('');
  const [productJson, setProductJson] = useState('');
  const [contentJson, setContentJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  const loadSnapshot = useCallback(async () => {
    const snapshot = await api('/api/store/snapshot');
    setProducts(Array.isArray(snapshot.products) ? snapshot.products.filter((item: unknown) => item && typeof item === 'object') : []);
    setOrders(Array.isArray(snapshot.orders) ? snapshot.orders.filter((item: unknown) => item && typeof item === 'object') : []);
    const nextContent = snapshot.content && typeof snapshot.content === 'object' ? snapshot.content : {};
    setContent(nextContent);
    setContentJson(JSON.stringify(nextContent, null, 2));
  }, []);

  useEffect(() => {
    let active = true;
    api('/api/admin/session').then(async (result) => {
      if (!active || !result.authenticated) return;
      setAuthenticated(true);
      try { await loadSnapshot(); }
      catch (loadError) { if (active) setError((loadError as Error).message); }
    }).catch((sessionError) => {
      if (active) setError((sessionError as Error).message);
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [loadSnapshot]);

  const stats = useMemo(() => ({
    products: products.length,
    orders: orders.length,
    pending: orders.filter((order) => !['livrée', 'annulée'].includes(String(order.status || '').toLowerCase())).length,
    revenue: orders.reduce((sum, order) => sum + (Number(order.totalAmount) || 0), 0),
  }), [products, orders]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setAuthenticated(true);
      setPassword('');
      await loadSnapshot();
    } catch (loginError) {
      setAuthenticated(false);
      setError((loginError as Error).message || 'Connexion impossible. Vérifie les identifiants et la configuration Render.');
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true); setError('');
    try { await api('/api/admin/logout', { method: 'POST' }); }
    catch (logoutError) { setError((logoutError as Error).message); }
    finally { setAuthenticated(false); setBusy(false); window.location.assign('/'); }
  }

  function selectProduct(id: string) {
    const product = products.find((item) => String(item.id) === id);
    setProductId(id);
    setProductJson(product ? JSON.stringify(product, null, 2) : '');
    setError('');
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const product = JSON.parse(productJson);
      if (!product || typeof product !== 'object' || Array.isArray(product) || !product.id) throw new Error('Le produit doit être un objet JSON avec un champ id.');
      await api(`/api/store/product/${encodeURIComponent(String(product.id))}`, { method: 'PUT', body: JSON.stringify(product) });
      setProducts((current) => current.some((item) => String(item.id) === String(product.id))
        ? current.map((item) => String(item.id) === String(product.id) ? product : item)
        : [product, ...current]);
      setProductId(String(product.id));
      setProductJson(JSON.stringify(product, null, 2));
    } catch (saveError) { setError((saveError as Error).message || 'Impossible d’enregistrer ce produit.'); }
    finally { setSaving(false); }
  }

  async function deleteProduct() {
    if (!productId || !window.confirm('Supprimer ce produit du catalogue ?')) return;
    setSaving(true); setError('');
    try {
      await api(`/api/store/product/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      setProducts((current) => current.filter((item) => String(item.id) !== productId));
      setProductId(''); setProductJson('');
    } catch (deleteError) { setError((deleteError as Error).message); }
    finally { setSaving(false); }
  }

  async function changeOrderStatus(order: JsonObject, status: string) {
    const ref = order.orderNumber || order.ref_command || order.id;
    if (!ref) { setError('Cette commande n’a pas de référence.'); return; }
    setError('');
    try {
      await api(`/api/orders/${encodeURIComponent(String(ref))}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setOrders((current) => current.map((item) => item === order ? { ...item, status } : item));
    } catch (orderError) { setError((orderError as Error).message); }
  }

  async function saveContent(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const nextContent = JSON.parse(contentJson);
      if (!nextContent || typeof nextContent !== 'object' || Array.isArray(nextContent)) throw new Error('Le contenu doit être un objet JSON.');
      await api('/api/store/content', { method: 'PUT', body: JSON.stringify(nextContent) });
      setContent(nextContent); setContentJson(JSON.stringify(nextContent, null, 2));
    } catch (contentError) { setError((contentError as Error).message || 'Impossible d’enregistrer le contenu.'); }
    finally { setSaving(false); }
  }

  if (checking) return <main className="grid min-h-screen place-items-center bg-black px-4 text-white"><p>Vérification de la session gérante…</p></main>;

  if (!authenticated) return <main className="grid min-h-screen place-items-center bg-black px-4 text-white">
    <form onSubmit={handleLogin} className="w-full max-w-md rounded-3xl border border-[#D4889E]/30 bg-[#14141A] p-7 shadow-2xl">
      <a href="/" className="mb-6 inline-block text-sm text-[#D4889E]">← Retour à la boutique</a>
      <p className="text-xs font-bold uppercase tracking-[.25em] text-[#D4889E]">Solena Clothing</p>
      <h1 className="mt-2 text-2xl font-bold">Espace gérante</h1>
      <p className="mt-2 text-sm text-white/60">Connecte-toi avec les identifiants configurés dans Render.</p>
      {error && <p role="alert" className="mt-5 rounded-xl border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-200">{error}</p>}
      <label className="mt-5 block text-sm text-white/80">Identifiant
        <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required className="mt-2 w-full rounded-xl border border-white/15 bg-black px-4 py-3 text-white outline-none focus:border-[#D4889E]" />
      </label>
      <label className="mt-4 block text-sm text-white/80">Mot de passe
        <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="mt-2 w-full rounded-xl border border-white/15 bg-black px-4 py-3 text-white outline-none focus:border-[#D4889E]" />
      </label>
      <button disabled={busy} className="mt-6 w-full rounded-xl bg-[#C96A87] px-4 py-3 font-bold text-white disabled:opacity-60">{busy ? 'Connexion…' : 'Se connecter'}</button>
    </form>
  </main>;

  const nav: { id: Section; label: string }[] = [
    { id: 'dashboard', label: 'Tableau de bord' }, { id: 'orders', label: 'Commandes' },
    { id: 'products', label: 'Produits' }, { id: 'content', label: 'Contenu du site' },
  ];

  return <main className="min-h-screen bg-black px-4 py-5 text-white sm:px-8">
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div><p className="text-xs font-bold uppercase tracking-[.25em] text-[#D4889E]">Solena Clothing</p><h1 className="mt-1 text-2xl font-bold">Espace gérante</h1></div>
        <div className="flex gap-2"><a href="/" className="rounded-xl border border-white/15 px-4 py-2 text-sm">Boutique</a><button onClick={logout} disabled={busy} className="rounded-xl bg-[#7C3F59] px-4 py-2 text-sm font-semibold">Déconnexion</button></div>
      </header>
      <nav className="my-5 flex flex-wrap gap-2">{nav.map((item) => <button key={item.id} onClick={() => { setSection(item.id); setError(''); }} className={`rounded-xl px-4 py-2 text-sm font-semibold ${section === item.id ? 'bg-[#C96A87] text-white' : 'border border-white/15 text-white/75'}`}>{item.label}</button>)}</nav>
      {error && <p role="alert" className="mb-5 rounded-xl border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-200">{error}</p>}
      {section === 'dashboard' && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Produits"><p className="text-3xl font-bold">{stats.products}</p></Card>
        <Card title="Commandes"><p className="text-3xl font-bold">{stats.orders}</p></Card>
        <Card title="À traiter"><p className="text-3xl font-bold">{stats.pending}</p></Card>
        <Card title="Ventes cumulées"><p className="text-xl font-bold">{money(stats.revenue)}</p></Card>
        <div className="sm:col-span-2 lg:col-span-4"><Card title="État de la boutique"><p className="text-sm text-white/70">Données synchronisées avec le stockage du site. Utilise les onglets pour gérer les commandes, les produits et le contenu.</p><button onClick={() => { setBusy(true); setError(''); loadSnapshot().catch((err) => setError(err.message)).finally(() => setBusy(false)); }} disabled={busy} className="mt-4 rounded-xl border border-white/20 px-4 py-2 text-sm">{busy ? 'Actualisation…' : 'Actualiser les données'}</button></Card></div>
      </div>}
      {section === 'orders' && <Card title={`Commandes (${orders.length})`}>
        {orders.length === 0 ? <p className="text-sm text-white/60">Aucune commande enregistrée.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="text-white/50"><tr><th className="p-3">Référence</th><th className="p-3">Client</th><th className="p-3">Date</th><th className="p-3">Total</th><th className="p-3">Statut</th></tr></thead><tbody>{orders.map((order, index) => <tr key={String(order.id || order.orderNumber || index)} className="border-t border-white/10"><td className="p-3">{order.orderNumber || order.ref_command || order.id || '—'}</td><td className="p-3">{order.customer?.fullName || order.customer?.name || '—'}</td><td className="p-3">{order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR') : '—'}</td><td className="p-3">{money(order.totalAmount)}</td><td className="p-3"><select value={String(order.status || 'en attente')} onChange={(event) => changeOrderStatus(order, event.target.value)} className="rounded-lg border border-white/15 bg-[#14141A] px-2 py-1"><option>en attente</option><option>payé</option><option>en préparation</option><option>expédiée</option><option>livrée</option><option>annulée</option></select></td></tr>)}</tbody></table></div>}
      </Card>}
      {section === 'products' && <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card title={`Catalogue (${products.length})`}><div className="max-h-[65vh] space-y-2 overflow-auto">{products.map((product, index) => <button key={String(product.id || index)} onClick={() => selectProduct(String(product.id))} className={`block w-full rounded-xl p-3 text-left text-sm ${productId === String(product.id) ? 'bg-[#7C3F59]' : 'bg-white/5 hover:bg-white/10'}`}><span className="block font-semibold">{product.name || 'Produit sans nom'}</span><span className="text-xs text-white/50">{money(product.price)}</span></button>)}</div><button onClick={() => { const fresh = { id: `prod-${Date.now()}`, name: '', description: '', category: 'Femme', gender: 'Femme', price: 0, images: [], variants: [{ id: `var-${Date.now()}`, size: 'M', color: 'Standard', stock: 0 }], inStock: false, featured: false, salesCount: 0 }; setProductId(String(fresh.id)); setProductJson(JSON.stringify(fresh, null, 2)); setError(''); }} className="mt-4 w-full rounded-xl border border-white/20 px-3 py-2 text-sm">+ Nouveau produit</button></Card>
        <Card title={productId ? 'Modifier le produit' : 'Sélectionne ou crée un produit'}>{productId ? <form onSubmit={saveProduct}><p className="mb-3 text-xs text-white/50">Modifie les champs JSON du produit; conserve son identifiant et la structure des variantes.</p><textarea value={productJson} onChange={(event) => setProductJson(event.target.value)} rows={22} spellCheck={false} className="w-full rounded-xl border border-white/15 bg-black p-3 font-mono text-xs text-white"/><div className="mt-3 flex gap-2"><button disabled={saving} className="rounded-xl bg-[#C96A87] px-4 py-2 text-sm font-bold">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>{products.some((item) => String(item.id) === productId) && <button type="button" onClick={deleteProduct} disabled={saving} className="rounded-xl border border-red-400/40 px-4 py-2 text-sm text-red-200">Supprimer</button>}</div></form> : <p className="text-sm text-white/60">Choisis un produit à gauche pour le modifier.</p>}</Card>
      </div>}
      {section === 'content' && <Card title="Contenu du site"><form onSubmit={saveContent}><p className="mb-3 text-sm text-white/60">Le contenu du site est enregistré en JSON pour préserver les paramètres et les textes existants.</p><textarea value={contentJson} onChange={(event) => setContentJson(event.target.value)} rows={26} spellCheck={false} className="w-full rounded-xl border border-white/15 bg-black p-3 font-mono text-xs text-white"/><div className="mt-3 flex gap-2"><button disabled={saving} className="rounded-xl bg-[#C96A87] px-4 py-2 text-sm font-bold">{saving ? 'Enregistrement…' : 'Enregistrer le contenu'}</button><button type="button" onClick={() => setContentJson(JSON.stringify(content, null, 2))} className="rounded-xl border border-white/20 px-4 py-2 text-sm">Annuler les modifications</button></div></form></Card>}
    </div>
  </main>;
}
