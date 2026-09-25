import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

type Data = Record<string, any>;
type Section = 'dashboard' | 'orders' | 'products' | 'content';

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Erreur serveur (${response.status})`);
  return result;
}
const money = (value: unknown) => `${(Number(value) || 0).toLocaleString('fr-FR')} FCFA`;
const control = 'mt-1.5 w-full rounded-xl border border-[#D9B9C3] bg-white px-3.5 py-3 text-sm text-[#30242A] outline-none transition focus:border-[#C96A87] focus:ring-2 focus:ring-[#C96A87]/15';
function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-[#EADDE1] bg-white p-5 shadow-[0_8px_30px_rgba(70,35,49,.06)] sm:p-6 ${className}`}><h2 className="mb-5 text-xs font-bold uppercase tracking-[.16em] text-[#8A5065]">{title}</h2>{children}</section>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium text-[#46363D]">{label}{children}</label>; }
function freshProduct(): Data { return { id: `prod-${Date.now()}`, name: '', description: '', category: 'Femme', gender: 'Femme', price: 0, images: [], variants: [{ id: `var-${Date.now()}`, size: 'M', color: 'Standard', stock: 0 }], inStock: false, featured: false, salesCount: 0 }; }

export default function AdminApp() {
  const [checking, setChecking] = useState(true), [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [section, setSection] = useState<Section>('dashboard');
  const [products, setProducts] = useState<Data[]>([]), [orders, setOrders] = useState<Data[]>([]), [content, setContent] = useState<Data>({});
  const [productId, setProductId] = useState(''), [product, setProduct] = useState<Data | null>(null), [uploading, setUploading] = useState(false), [search, setSearch] = useState('');
  const contentTimer = useRef<ReturnType<typeof setTimeout> | null>(null), contentLoaded = useRef(false);

  const loadSnapshot = useCallback(async () => {
    const snapshot = await api('/api/store/snapshot');
    setProducts(Array.isArray(snapshot.products) ? snapshot.products.filter((x: unknown) => x && typeof x === 'object') : []);
    setOrders(Array.isArray(snapshot.orders) ? snapshot.orders.filter((x: unknown) => x && typeof x === 'object') : []);
    const next = snapshot.content && typeof snapshot.content === 'object' ? snapshot.content : {};
    contentLoaded.current = true; setContent(next);
  }, []);
  useEffect(() => {
    let active = true;
    api('/api/admin/session').then(async (r) => { if (active && r.authenticated) { setAuthenticated(true); try { await loadSnapshot(); } catch (e) { if (active) setError((e as Error).message); } } })
      .catch((e) => { if (active) setError((e as Error).message); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [loadSnapshot]);
  useEffect(() => () => { if (contentTimer.current) clearTimeout(contentTimer.current); }, []);
  const stats = useMemo(() => ({ products: products.length, orders: orders.length, pending: orders.filter(o => !['livrée', 'livré', 'annulée', 'annulé'].includes(String(o.status || '').toLowerCase())).length, revenue: orders.reduce((n, o) => n + (Number(o.totalAmount) || 0), 0) }), [products, orders]);
  const visibleProducts = products.filter(p => `${p.name || ''} ${p.category || ''}`.toLowerCase().includes(search.toLowerCase()));

  async function handleLogin(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }); setAuthenticated(true); setPassword(''); await loadSnapshot(); } catch (e) { setAuthenticated(false); setError((e as Error).message); } finally { setBusy(false); } }
  async function logout() { setBusy(true); try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) { setError((e as Error).message); } finally { setAuthenticated(false); setBusy(false); window.location.assign('/'); } }
  function chooseProduct(id: string) { const found = products.find(p => String(p.id) === id); setProductId(id); setProduct(found ? structuredClone(found) : null); setError(''); setNotice(''); }
  function patchProduct(key: string, value: unknown) { setProduct((p) => p ? { ...p, [key]: value } : p); }
  async function saveProduct(event: FormEvent) {
    event.preventDefault(); if (!product) return; setSaving(true); setError(''); setNotice('');
    try {
      const normalized: Data = { ...product, name: String(product.name || '').trim(), price: Number(product.price) || 0, images: Array.isArray(product.images) ? product.images : [], variants: Array.isArray(product.variants) ? product.variants : [] };
      if (!normalized.name) throw new Error('Ajoute le nom du produit avant de l’enregistrer.');
      await api(`/api/store/product/${encodeURIComponent(String(normalized.id))}`, { method: 'PUT', body: JSON.stringify(normalized) });
      setProducts(current => current.some(p => String(p.id) === String(normalized.id)) ? current.map(p => String(p.id) === String(normalized.id) ? normalized : p) : [normalized, ...current]);
      setProduct(normalized); setProductId(String(normalized.id)); setNotice('Produit enregistré.');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  async function uploadImages(files: FileList | null) {
    if (!files?.length || !product) return;
    setUploading(true); setError(''); setNotice('');
    try {
      const urls: string[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) throw new Error(`${file.name} n’est pas une image.`);
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} dépasse la limite de 5 Mo.`);
        const imageBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Lecture de l’image impossible.')); reader.readAsDataURL(file); });
        const result = await api('/api/upload', { method: 'POST', body: JSON.stringify({ imageBase64, filename: file.name }) }); urls.push(result.url);
      }
      setProduct(p => p ? { ...p, images: [...(Array.isArray(p.images) ? p.images : []), ...urls] } : p);
      setNotice(`${urls.length} image${urls.length > 1 ? 's ajoutées' : ' ajoutée'}. Enregistre le produit pour les afficher dans la boutique.`);
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  function removeImage(index: number) { if (product) patchProduct('images', product.images.filter((_: string, i: number) => i !== index)); }
  async function removeProduct() {
    if (!productId || !window.confirm('Supprimer ce produit du catalogue ?')) return;
    setSaving(true); try { await api(`/api/store/product/${encodeURIComponent(productId)}`, { method: 'DELETE' }); setProducts(p => p.filter(x => String(x.id) !== productId)); setProduct(null); setProductId(''); setNotice('Produit supprimé.'); } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  async function changeOrderStatus(order: Data, status: string) {
    const ref = order.orderNumber || order.ref_command || order.id; if (!ref) return setError('Cette commande n’a pas de référence.');
    try { await api(`/api/orders/${encodeURIComponent(String(ref))}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setOrders(all => all.map(o => o === order ? { ...o, status } : o)); }
    catch (e) { setError((e as Error).message); }
  }
  async function deleteOrder(order: Data) {
    const ref = order.orderNumber || order.ref_command || order.id; if (!ref || !window.confirm(`Supprimer définitivement la commande ${ref} ?`)) return;
    try { await api(`/api/orders/${encodeURIComponent(String(ref))}`, { method: 'DELETE' }); setOrders(all => all.filter(o => o !== order)); setNotice(`Commande ${ref} supprimée.`); }
    catch (e) { setError((e as Error).message); }
  }
  function updateContent(path: string[], value: unknown) {
    setContent(prev => {
      const next = structuredClone(prev);
      let cursor = next;
      for (const key of path.slice(0, -1)) {
        cursor[key] = { ...(cursor[key] || {}) };
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = value;
      return next;
    });
    if (contentTimer.current) clearTimeout(contentTimer.current);
    contentTimer.current = setTimeout(async () => { try { setSaving(true); await api('/api/store/content', { method: 'PUT', body: JSON.stringify(contentRef.current) }); setNotice('Modifications enregistrées automatiquement.'); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } }, 700);
  }
  const contentRef = useRef(content); contentRef.current = content;
  // The content form saves after each edit, while retaining all untouched site settings.

  if (checking) return <main className="grid min-h-screen place-items-center bg-[#FBF3F1] text-[#30242A]">Vérification de l’espace gérante…</main>;
  if (!authenticated) return <main className="grid min-h-screen place-items-center bg-[#FBF3F1] px-4 text-[#30242A]"><form onSubmit={handleLogin} className="w-full max-w-md rounded-[28px] border border-[#EADDE1] bg-white p-8 shadow-xl">
    <a href="/" className="mb-8 inline-block text-sm text-[#8A5065]">← Retour à la boutique</a><div className="mb-6 h-1 w-14 rounded-full bg-[#C96A87]"/><p className="text-xs font-bold uppercase tracking-[.24em] text-[#8A5065]">Solena Clothing</p><h1 className="mt-2 font-serif text-3xl">Espace gérante</h1><p className="mt-2 text-sm text-[#76666D]">Connecte-toi pour gérer la boutique.</p>
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}<Field label="Identifiant"><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required className={control}/></Field><div className="mt-4"/><Field label="Mot de passe"><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required className={control}/></Field><button disabled={busy} className="mt-6 w-full rounded-xl bg-[#C96A87] px-4 py-3 font-bold text-white hover:bg-[#A95070] disabled:opacity-60">{busy ? 'Connexion…' : 'Se connecter'}</button>
  </form></main>;

  const nav: { id: Section; label: string; icon: string }[] = [{ id: 'dashboard', label: 'Accueil', icon: '⌂' }, { id: 'orders', label: 'Commandes', icon: '▤' }, { id: 'products', label: 'Produits', icon: '◇' }, { id: 'content', label: 'Textes du site', icon: '✎' }];
  const textField = (label: string, path: string[], multiline = false) => <Field key={path.join('.')} label={label}>{multiline ? <textarea rows={3} value={path.reduce((v: any, k) => v?.[k], content) || ''} onChange={e => updateContent(path, e.target.value)} className={control}/> : <input value={path.reduce((v: any, k) => v?.[k], content) || ''} onChange={e => updateContent(path, e.target.value)} className={control}/>}</Field>;
  return <main className="min-h-screen bg-[#FBF3F1] text-[#30242A]">
    <header className="border-b border-[#EADDE1] bg-white"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-8"><div><p className="text-[10px] font-bold uppercase tracking-[.25em] text-[#A3657A]">Maison Solena</p><h1 className="font-serif text-2xl">Espace gérante</h1></div><div className="flex gap-2"><a href="/" className="rounded-xl border border-[#EADDE1] px-4 py-2 text-sm">Voir la boutique</a><button onClick={logout} disabled={busy} className="rounded-xl bg-[#7C3F59] px-4 py-2 text-sm font-semibold text-white">Déconnexion</button></div></div></header>
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8"><nav className="mb-6 flex gap-2 overflow-x-auto rounded-2xl border border-[#EADDE1] bg-white p-2">{nav.map(item => <button key={item.id} onClick={() => { setSection(item.id); setError(''); setNotice(''); }} className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold transition ${section === item.id ? 'bg-[#C96A87] text-white shadow-sm' : 'text-[#6E5962] hover:bg-[#FBF3F1]'}`}><span className="mr-2">{item.icon}</span>{item.label}</button>)}</nav>
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}{notice && !error && <p role="status" className="mb-4 rounded-xl border border-[#D9B9C3] bg-white p-3 text-sm text-[#704353]">{notice}</p>}
      {section === 'dashboard' && <><div className="mb-6"><p className="text-sm text-[#8A5065]">Bonjour, bienvenue dans votre boutique.</p><h2 className="font-serif text-3xl">Vue d’ensemble</h2></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[['Produits', stats.products], ['Commandes', stats.orders], ['À traiter', stats.pending], ['Ventes cumulées', money(stats.revenue)]].map(([label, value]) => <Card key={String(label)} title={String(label)}><p className="font-serif text-3xl text-[#7C3F59]">{value}</p></Card>)}</div><Card title="Raccourcis" className="mt-4"><div className="flex flex-wrap gap-3">{nav.slice(1).map(n => <button key={n.id} onClick={() => setSection(n.id)} className="rounded-xl bg-[#FBF3F1] px-4 py-3 text-sm font-semibold text-[#704353] hover:bg-[#F3E3E8]">{n.icon}　Gérer {n.label.toLowerCase()} →</button>)}</div></Card></>}
      {section === 'orders' && <Card title={`Commandes · ${orders.length}`}><p className="-mt-3 mb-5 text-sm text-[#76666D]">Mettez à jour le suivi ou supprimez une commande.</p>{orders.length === 0 ? <p className="py-8 text-center text-sm text-[#76666D]">Aucune commande enregistrée.</p> : <div className="space-y-3">{orders.map((order, i) => { const ref = order.orderNumber || order.ref_command || order.id || i; return <article key={String(ref)} className="grid gap-3 rounded-xl border border-[#EADDE1] bg-[#FFFCFB] p-4 sm:grid-cols-[1.2fr_1fr_auto_auto] sm:items-center"><div><p className="font-semibold">{ref}</p><p className="text-sm text-[#76666D]">{order.customer?.fullName || order.customer?.name || 'Client'} · {order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR') : 'Date inconnue'}</p><p className="text-xs text-[#76666D]">{order.customer?.neighborhood || order.customer?.city || 'Quartier non indiqué'} · {order.customer?.address || 'Adresse non indiquée'}</p><p className="text-xs font-semibold text-[#8A5065]">Livraison à remettre au livreur : {money(order.shippingFee)}</p></div><p className="font-semibold text-[#7C3F59]">{money(order.totalAmount)}</p><select aria-label={`Statut commande ${ref}`} value={String(order.status || 'en attente')} onChange={e => changeOrderStatus(order, e.target.value)} className="rounded-lg border border-[#D9B9C3] bg-white px-3 py-2 text-sm"><option>en attente</option><option>payé</option><option>en préparation</option><option>expédiée</option><option>livrée</option><option>annulée</option></select><button onClick={() => deleteOrder(order)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Supprimer</button></article>; })}</div>}</Card>}
      {section === 'products' && <div className="grid gap-4 lg:grid-cols-[280px_1fr]"><Card title={`Catalogue · ${products.length}`}><input aria-label="Rechercher un produit" placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} className={control}/><div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">{visibleProducts.map((p, i) => <button key={String(p.id || i)} onClick={() => chooseProduct(String(p.id))} className={`flex w-full items-center gap-3 rounded-xl p-2.5 text-left ${productId === String(p.id) ? 'bg-[#F3E3E8]' : 'hover:bg-[#FBF3F1]'}`}><img src={p.images?.[0] || 'https://placehold.co/80x80/F3E3E8/7C3F59?text=SC'} className="h-12 w-12 rounded-lg object-cover"/><span className="min-w-0"><b className="block truncate text-sm">{p.name || 'Sans nom'}</b><span className="text-xs text-[#76666D]">{money(p.price)}</span></span></button>)}</div><button onClick={() => { const fresh = freshProduct(); setProductId(fresh.id); setProduct(fresh); setError(''); setNotice(''); }} className="mt-4 w-full rounded-xl bg-[#7C3F59] px-4 py-3 text-sm font-bold text-white hover:bg-[#623147]">＋ Ajouter un produit</button></Card>
        <Card title={product ? (products.some(p => String(p.id) === productId) ? 'Fiche produit' : 'Nouveau produit') : 'Votre catalogue'}>{!product ? <div className="py-10 text-center"><p className="font-serif text-2xl">Choisissez un produit</p><p className="mt-2 text-sm text-[#76666D]">Ou ajoutez une création pour commencer.</p></div> : <form onSubmit={saveProduct} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><Field label="Nom du produit"><input required value={product.name || ''} onChange={e => patchProduct('name', e.target.value)} className={control} placeholder="Ex. Robe satinée"/></Field><Field label="Prix (FCFA)"><input type="number" min="0" value={product.price ?? 0} onChange={e => patchProduct('price', Number(e.target.value))} className={control}/></Field><Field label="Collection"><select value={product.category || 'Femme'} onChange={e => { patchProduct('category', e.target.value); patchProduct('gender', e.target.value); }} className={control}><option>Femme</option><option>Homme</option><option>Pyjama (unisexe)</option></select></Field><Field label="Stock total"><input type="number" min="0" value={(product.variants || []).reduce((n: number, v: Data) => n + (Number(v.stock) || 0), 0)} onChange={e => { const current = product.variants?.length ? product.variants : [{ id: `var-${Date.now()}`, size: 'Unique', color: 'Standard' }]; patchProduct('variants', current.map((v: Data, i: number) => i === 0 ? { ...v, stock: Number(e.target.value) } : { ...v, stock: 0 })); patchProduct('inStock', Number(e.target.value) > 0); }} className={control}/></Field></div><Field label="Description"><textarea rows={4} value={product.description || ''} onChange={e => patchProduct('description', e.target.value)} className={control} placeholder="Décrivez le produit et ses détails…"/></Field><div className="flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!product.featured} onChange={e => patchProduct('featured', e.target.checked)} className="accent-[#C96A87]"/> Mettre en vedette</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!product.isNew} onChange={e => patchProduct('isNew', e.target.checked)} className="accent-[#C96A87]"/> Nouveauté</label></div>
          <div><div className="mb-2 flex flex-wrap items-end justify-between gap-2"><div><p className="text-sm font-semibold">Photos du produit</p><p className="text-xs text-[#76666D]">Choisissez des images sur cet appareil. 5 Mo maximum par image.</p></div><label className={`cursor-pointer rounded-xl border border-[#D9B9C3] px-4 py-2.5 text-sm font-semibold text-[#704353] hover:bg-[#FBF3F1] ${uploading ? 'pointer-events-none opacity-50' : ''}`}>{uploading ? 'Téléversement…' : '＋ Ajouter des photos'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="hidden" disabled={uploading} onChange={e => { void uploadImages(e.target.files); e.currentTarget.value = ''; }}/></label></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(product.images || []).map((url: string, i: number) => <div key={`${url}-${i}`} className="group relative aspect-square overflow-hidden rounded-xl bg-[#FBF3F1]"><img src={url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover"/><button type="button" onClick={() => removeImage(i)} aria-label="Retirer cette photo" className="absolute right-2 top-2 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-red-700 shadow">×</button></div>)}</div></div>
          <div className="flex flex-wrap gap-2 border-t border-[#EADDE1] pt-4"><button disabled={saving || uploading} className="rounded-xl bg-[#C96A87] px-5 py-3 text-sm font-bold text-white hover:bg-[#A95070] disabled:opacity-50">{saving ? 'Enregistrement…' : 'Enregistrer le produit'}</button>{products.some(p => String(p.id) === productId) && <button type="button" onClick={removeProduct} disabled={saving} className="rounded-xl border border-red-200 px-4 py-3 text-sm font-semibold text-red-700">Supprimer le produit</button>}</div></form>}</Card></div>}
      {section === 'content' && <div className="grid gap-4 xl:grid-cols-2"><Card title="Bandeau d’accueil"><p className="-mt-3 mb-5 text-sm text-[#76666D]">Les changements sont enregistrés automatiquement.</p><div className="space-y-4">{textField('Petit badge', ['banner', 'badgeText'])}{textField('Grand titre', ['banner', 'title'])}{textField('Texte de présentation', ['banner', 'subtitle'], true)}{textField('Texte du bouton', ['banner', 'buttonText'])}{textField('Annonce en haut de page', ['banner', 'announcementText'])}{textField('Adresse web de la photo du bandeau', ['banner', 'imageUrl'])}</div></Card>
        <div className="space-y-4"><Card title="Présentation de la maison"><div className="space-y-4">{textField('Titre', ['aboutStory', 'title'])}{textField('Sous-titre', ['aboutStory', 'subtitle'], true)}{(content.aboutStory?.paragraphs || []).map((p: string, i: number) => <Field key={i} label={`Paragraphe ${i + 1}`}><textarea rows={3} value={p} onChange={e => { const paragraphs = [...(content.aboutStory?.paragraphs || [])]; paragraphs[i] = e.target.value; updateContent(['aboutStory', 'paragraphs'], paragraphs); }} className={control}/></Field>)}</div></Card><Card title="Coordonnées affichées"><div className="space-y-4">{textField('Nom de la boutique', ['settings', 'storeName'])}{textField('Téléphone', ['settings', 'storePhone'])}{textField('WhatsApp (indicatif + numéro)', ['settings', 'managerWhatsAppNumber'])}{textField('E-mail', ['settings', 'storeEmail'])}{textField('Adresse', ['settings', 'storeAddress'])}</div></Card></div>
        <Card title="Collections à l’accueil" className="xl:col-span-2"><div className="grid gap-5 md:grid-cols-3">{(content.categories || []).map((cat: Data, i: number) => <div key={cat.id || i} className="space-y-3 rounded-xl bg-[#FFFCFB] p-4"><p className="font-semibold text-[#704353]">Collection {i + 1}</p><Field label="Nom"><input value={cat.name || ''} onChange={e => { const a = [...content.categories]; a[i] = { ...a[i], name: e.target.value }; updateContent(['categories'], a); }} className={control}/></Field><Field label="Description"><textarea rows={3} value={cat.description || ''} onChange={e => { const a = [...content.categories]; a[i] = { ...a[i], description: e.target.value }; updateContent(['categories'], a); }} className={control}/></Field><Field label="Lien de la photo"><input value={cat.imageUrl || ''} onChange={e => { const a = [...content.categories]; a[i] = { ...a[i], imageUrl: e.target.value }; updateContent(['categories'], a); }} className={control}/></Field></div>)}</div></Card></div>}
      <footer className="py-8 text-center text-xs text-[#9A858D]">Solena Clothing · Administration sécurisée</footer>
    </div>
  </main>;
}
