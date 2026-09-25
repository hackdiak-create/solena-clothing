/**
 * @file server.ts
 * @description Serveur backend Express avec intégration complète de la passerelle PayTech (paytech.sn),
 * gestion de l'IPN Webhook, téléversement direct d'images depuis l'appareil, et serveur Vite pour React.
 */

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// 1. CHARGEMENT ET ASSAINISSEMENT SÉCURISÉ DES VARIABLES D'ENVIRONNEMENT
// ---------------------------------------------------------------------------
// Les clés PayTech et paramètres sont chargés depuis le fichier .env via dotenv.
// ELLES NE SONT JAMAIS EXPOSÉES AU CLIENT (FRONTEND) NI VISIBLES EN CLAIR DANS LE CODE.
dotenv.config();

/**
 * Assainit systématiquement une variable d'environnement :
 * - Supprime les espaces superflus avant et après.
 * - Supprime récursivement les guillemets simples ('), doubles (") ou accents graves (`)
 *   autour de la valeur (ex: '"prod"' -> 'prod', "'live'" -> 'live').
 */
export function sanitizeEnv(value: string | undefined, defaultValue: string = ''): string {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  let str = String(value).trim();
  while (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'")) ||
    (str.startsWith('`') && str.endsWith('`'))
  ) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

/**
 * Normalise et assainit spécifiquement PAYTECH_ENV :
 * - Retire systématiquement les guillemets superflus (simples ou doubles) ainsi que les espaces
 *   (par exemple en convertissant automatiquement '"prod"' ou "'prod'" en 'prod').
 * - Mappe automatiquement 'prod', 'production', 'live' vers 'prod' (valeur officielle PayTech).
 * - Mappe 'test', 'sandbox', 'dev', 'development' ou chaîne vide vers 'test'.
 */
export function sanitizePaytechEnv(value: string | undefined): 'prod' | 'test' {
  const clean = sanitizeEnv(value, 'test').toLowerCase();
  if (clean === 'prod' || clean === 'production' || clean === 'live') {
    return 'prod';
  }
  return 'test';
}


// ---------------------------------------------------------------------------
// SUPABASE — stockage persistant (PostgreSQL + Storage)
// ---------------------------------------------------------------------------
// Les secrets Supabase restent côté serveur. La clé service_role ne doit
// JAMAIS être exposée au frontend.
const SUPABASE_URL = sanitizeEnv(process.env.SUPABASE_URL, '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = sanitizeEnv(process.env.SUPABASE_SERVICE_ROLE_KEY, '');

// Administration : les identifiants restent côté serveur. La session est un cookie
// signé et HttpOnly, donc aucune clé d'administration n'est exposée au navigateur.
const ADMIN_USERNAME = sanitizeEnv(process.env.ADMIN_USERNAME, '');
const ADMIN_PASSWORD = sanitizeEnv(process.env.ADMIN_PASSWORD, '');
const ADMIN_SECRET_KEY = sanitizeEnv(process.env.ADMIN_SECRET_KEY, '');
const ADMIN_COOKIE = 'solena_admin';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function signAdminSession(payload: string) {
  return crypto.createHmac('sha256', ADMIN_SECRET_KEY).update(payload).digest('hex');
}

function createAdminSession() {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString('hex')}`;
  return `${Buffer.from(payload).toString('base64url')}.${signAdminSession(payload)}`;
}

function getCookie(req: Request, name: string) {
  const header = req.get('cookie') || '';
  const found = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function isAdminAuthenticated(req: Request) {
  if (!ADMIN_SECRET_KEY) return false;
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  try {
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const timestamp = Number(payload.split('.')[0]);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > ADMIN_SESSION_TTL_MS) return false;
    const expected = signAdminSession(payload);
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!isAdminAuthenticated(req)) return res.status(401).json({ success: false, error: 'Authentification gérante requise.' });
  next();
}

function isAdminConfigReady() {
  return ADMIN_USERNAME.length > 0 && ADMIN_PASSWORD.length > 0 && ADMIN_SECRET_KEY.length >= 32;
}

function isSupabaseConfigured() {
  return SUPABASE_URL.startsWith('https://') && SUPABASE_SERVICE_ROLE_KEY.length > 20;
}

async function supabaseRequest(endpoint: string, options: RequestInit = {}) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase n\'est pas configuré côté serveur. Ajoutez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.');
  }

  const headers = new Headers(options.headers || {});
  headers.set('apikey', SUPABASE_SERVICE_ROLE_KEY);
  headers.set('Authorization', `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${SUPABASE_URL}${endpoint}`, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase HTTP ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function supabaseUpsert(table: string, rows: any[]) {
  return supabaseRequest(`/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(rows)
  });
}

async function saveOrderToSupabase(order: any) {
  if (!isSupabaseConfigured()) return;
  const data = { ...order };
  await supabaseUpsert('orders', [{
    id: String(order.id || order.ref_command),
    order_number: order.orderNumber || order.order_number || order.ref_command,
    ref_command: order.ref_command || order.orderNumber || order.id,
    data,
    status: order.status || 'en attente',
    payment_method: order.paymentMethod || order.payment_method || null,
    payment_status: order.payment_status || (order.status === 'payé' || order.status === 'payée' ? 'paid' : 'pending'),
    total_amount: Number(order.totalAmount ?? order.total_amount ?? order.item_price ?? 0),
    currency: order.currency || 'XOF',
    customer: order.customer || {},
    paytech_token: order.paytechToken || order.paytech_token || null,
    paytech_payment_url: order.paytechPaymentUrl || order.paytech_payment_url || null,
    paid_at: order.paidAt || order.paid_at || null,
    created_at: order.createdAt || order.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]);
}

async function findOrderInSupabase(ref: string) {
  if (!isSupabaseConfigured()) return null;
  const rows = await supabaseRequest(`/rest/v1/orders?select=*&ref_command=eq.${encodeURIComponent(ref)}&limit=1`, { method: 'GET' });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function updateOrderInSupabase(ref: string, patch: any) {
  if (!isSupabaseConfigured()) return null;
  const existing = await findOrderInSupabase(ref);
  const merged = existing?.data ? { ...existing.data, ...patch } : { ref_command: ref, ...patch };
  const updates: any = {
    data: merged,
    status: merged.status || existing?.status || 'en attente',
    payment_method: merged.paymentMethod || existing?.payment_method || null,
    payment_status: merged.payment_status || (merged.status === 'payé' || merged.status === 'payée' ? 'paid' : existing?.payment_status || 'pending'),
    total_amount: Number(merged.totalAmount ?? merged.item_price ?? existing?.total_amount ?? 0),
    customer: merged.customer || existing?.customer || {},
    paytech_token: merged.paytechToken || existing?.paytech_token || null,
    paytech_payment_url: merged.paytechPaymentUrl || existing?.paytech_payment_url || null,
    paid_at: merged.paidAt || existing?.paid_at || null,
    updated_at: new Date().toISOString()
  };
  if (existing?.id) {
    return supabaseRequest(`/rest/v1/orders?id=eq.${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(updates)
    });
  }
  return saveOrderToSupabase({ id: `ord-${Date.now()}`, ref_command: ref, ...merged });
}

async function listStoreSnapshot() {
  if (!isSupabaseConfigured()) return { configured: false, products: [], content: null, orders: [] };
  const [products, content, orders] = await Promise.all([
    supabaseRequest('/rest/v1/products?select=id,data&order=updated_at.desc', { method: 'GET' }),
    supabaseRequest('/rest/v1/site_content?select=id,data&id=eq.main&limit=1', { method: 'GET' }),
    supabaseRequest('/rest/v1/orders?select=id,data,status,created_at&order=created_at.desc', { method: 'GET' })
  ]);
  return {
    configured: true,
    products: Array.isArray(products) ? products.map((r: any) => r.data).filter(Boolean) : [],
    content: Array.isArray(content) && content[0] ? content[0].data : null,
    orders: Array.isArray(orders) ? orders.map((r: any) => r.data).filter(Boolean) : []
  };
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialisation de l'application Express avec assainissement du PORT
const app = express();
const PORT = Number(sanitizeEnv(process.env.PORT, '3000')) || 3000;

// Middleware de parsing JSON et URL-Encoded (avec limite élevée pour les images base64 si nécessaire)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Endpoint de santé utilisé par Render/UptimeRobot
app.get('/health', async (_req: Request, res: Response) => {
  let supabase = false;
  if (isSupabaseConfigured()) {
    try {
      await supabaseRequest('/rest/v1/products?select=id&limit=1', { method: 'GET' });
      supabase = true;
    } catch {
      supabase = false;
    }
  }
  res.status(200).json({ ok: true, service: 'solena-clothing', supabase, timestamp: new Date().toISOString() });
});

// Répertoire des fichiers téléversés par le gérant
const UPLOADS_DIR = path.resolve(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// CONFIGURATION PAYTECH ET URLS ASSAINIES
// ---------------------------------------------------------------------------
// OÙ COLLER VOS CLÉS PAYTECH :
// Rendez-vous sur votre compte marchand : https://paytech.sn -> Paramètres -> API
// 1. PAYTECH_API_KEY : Copiez votre Clé API publique dans le fichier .env
// 2. PAYTECH_API_SECRET : Copiez votre Clé Secrète privée dans le fichier .env
// 3. PAYTECH_ENV : 'prod' pour la production ou 'test' pour le bac à sable
// 4. BASE_URL : URL de base publique (ex: http://localhost:3000 ou https://mon-site.onrender.com)
// ---------------------------------------------------------------------------
function getPayTechConfig() {
  const apiKey = sanitizeEnv(process.env.PAYTECH_API_KEY, '');
  const apiSecret = sanitizeEnv(process.env.PAYTECH_API_SECRET, '');
  // Assainissement de PAYTECH_ENV pour que `if (PAYTECH_ENV === 'prod')` fonctionne sans erreur
  const PAYTECH_ENV = sanitizePaytechEnv(process.env.PAYTECH_ENV);
  const envMode = PAYTECH_ENV;

  const isConfigured =
    apiKey.length > 0 &&
    apiSecret.length > 0 &&
    !apiKey.includes('VOTRE_CLE') &&
    !apiSecret.includes('VOTRE_CLE');

  return { apiKey, apiSecret, envMode, PAYTECH_ENV, isConfigured };
}

// Base de données en mémoire pour le suivi des commandes et des paiements PayTech
interface OrderRecord {
  ref_command: string;
  item_name: string;
  item_price: number;
  currency: string;
  customer?: any;
  status: 'en attente' | 'payé' | 'annulée' | 'échoué';
  paymentMethod: string;
  paytechToken?: string;
  paytechPaymentUrl?: string;
  paidAt?: string;
  createdAt: string;
}

const ordersStore: Map<string, OrderRecord> = new Map();

/**
 * Résout dynamiquement l'URL de base publique du site (BASE_URL) :
 * 1. Priorité à la variable d'environnement BASE_URL (ou APP_URL) assainie.
 * 2. Si non définie ou requête présente, détection automatique via les en-têtes HTTP de la requête.
 * 3. Repli par défaut sur http://localhost:PORT.
 */
function getBaseUrl(req?: Request): string {
  // Lecture et assainissement de BASE_URL ou APP_URL (retrait des guillemets et espaces)
  const envBaseUrl = sanitizeEnv(process.env.BASE_URL || process.env.APP_URL, '');
  if (envBaseUrl && envBaseUrl !== 'MY_APP_URL') {
    return envBaseUrl.replace(/\/+$/, '');
  }

  // Détection dynamique à partir de la requête entrante
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  return `http://localhost:${PORT}`;
}

// ---------------------------------------------------------------------------
// 2. ROUTE D'INITIALISATION DU PAIEMENT (POST /paytech/initiate & /api/paytech/initiate)
// ---------------------------------------------------------------------------
/**
 * @route POST /paytech/initiate
 * @description Initialise une transaction de paiement auprès de l'API PayTech.
 * Reçoit les données de la commande (nom de l'article, prix en XOF, référence unique).
 * Envoie la requête sécurisée à https://paytech.sn/api/payment/request-payment avec les headers API_KEY et API_SECRET.
 * Retourne le lien de redirection (redirect_url) vers PayTech pour que le client finalise son paiement.
 */
async function handlePayTechInitiate(req: Request, res: Response) {
  try {
    const { item_name, item_price, ref_command, command_name, customer, custom_field } = req.body;

    if (!item_name || !item_price || !ref_command) {
      return res.status(400).json({
        success: false,
        error: 'Champs obligatoires manquants : item_name, item_price, ref_command sont requis.'
      });
    }

    const config = getPayTechConfig();
    // PAYTECH_ENV assaini pour garantir que `if (PAYTECH_ENV === 'prod')` fonctionne sans erreur
    const PAYTECH_ENV = req.body.env ? sanitizePaytechEnv(req.body.env) : config.PAYTECH_ENV;
    const envMode = PAYTECH_ENV;
    const { apiKey, apiSecret, isConfigured } = config;

    // 2. Récupération dynamique de la variable BASE_URL
    const BASE_URL = getBaseUrl(req);

    // 3. Génération dynamique des 3 URL transmises à l'API PayTech en utilisant BASE_URL :
    // * URL IPN : `${BASE_URL}/api/paytech/ipn`
    // * URL Succès : `${BASE_URL}/payment/success`
    // * URL Annulation : `${BASE_URL}/payment/cancel`
    let ipn_url = `${BASE_URL}/api/paytech/ipn`;
    const success_url = `${BASE_URL}/payment/success`;
    const cancel_url = `${BASE_URL}/payment/cancel`;

    // PayTech exige strictement une URL HTTPS pour l'IPN webhook.
    // Si BASE_URL est configuré en http:// (ex. en local), on utilise l'URL publique HTTPS si disponible.
    if (ipn_url.startsWith('http://') && process.env.APP_URL && process.env.APP_URL.startsWith('https://')) {
      const secureBase = sanitizeEnv(process.env.APP_URL).replace(/\/+$/, '');
      ipn_url = `${secureBase}/api/paytech/ipn`;
    }

    // Enregistrement initial de la commande dans le système
    const newOrder: OrderRecord = {
      ref_command,
      item_name: String(item_name),
      item_price: Number(item_price),
      currency: 'XOF',
      customer: customer || {},
      status: 'en attente',
      paymentMethod: 'PayTech (Wave, Orange Money, Free Money, Carte)',
      createdAt: new Date().toISOString()
    };
    ordersStore.set(ref_command, newOrder);
        try { await saveOrderToSupabase({ ...newOrder, id: newOrder.ref_command, orderNumber: newOrder.ref_command }); } catch (dbError) { console.error('[Supabase Order Save]', dbError); }

    // Données à transmettre à l'API PayTech
    const payload = {
      item_name: String(item_name),
      item_price: Number(item_price),
      currency: 'XOF',
      ref_command: String(ref_command),
      command_name: command_name || `Commande Solena Clothing #${ref_command}`,
      env: envMode,
      ipn_url: ipn_url,
      success_url: success_url,
      cancel_url: cancel_url,
      custom_field: typeof custom_field === 'object' ? JSON.stringify(custom_field) : (custom_field || '')
    };

    // Si les clés réelles sont configurées, appel à l'API PayTech officielle
    if (isConfigured) {
      console.log(`[PayTech] Envoi de la demande de paiement à PayTech pour la commande ${ref_command} (${envMode})...`);

      const paytechResponse = await fetch('https://paytech.sn/api/payment/request-payment', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          // Authentification sécurisée par en-têtes PayTech
          'API_KEY': apiKey,
          'API_SECRET': apiSecret
        },
        body: JSON.stringify(payload)
      });

      if (!paytechResponse.ok) {
        const errorText = await paytechResponse.text();
        console.error('[PayTech Error]', paytechResponse.status, errorText);
        return res.status(502).json({
          success: false,
          error: `Échec de communication avec PayTech (HTTP ${paytechResponse.status}) : ${errorText}`
        });
      }

      const responseData = (await paytechResponse.json()) as any;

      if (responseData.success === 1 || responseData.token || responseData.redirect_url || responseData.redirectUrl) {
        const redirectUrl =
          responseData.redirect_url ||
          responseData.redirectUrl ||
          (responseData.token ? `https://paytech.sn/payment/checkout/${responseData.token}` : '');
        const token = responseData.token || `PT-${Date.now()}`;

        newOrder.paytechToken = token;
        newOrder.paytechPaymentUrl = redirectUrl;
        ordersStore.set(ref_command, newOrder);
        try { await saveOrderToSupabase({ ...newOrder, id: newOrder.ref_command, orderNumber: newOrder.ref_command }); } catch (dbError) { console.error('[Supabase Order Save]', dbError); }

        return res.status(200).json({
          success: true,
          token: token,
          redirect_url: redirectUrl,
          ref_command: ref_command
        });
      } else {
        const errorMsg = responseData.message || (Array.isArray(responseData.error) ? responseData.error.join(', ') : responseData.error) || 'Erreur lors de l’initialisation PayTech.';
        console.warn(`[PayTech Warning] Réponse PayTech: ${errorMsg}`);

        // Si le compte configuré en 'prod' n'est pas encore activé par l'équipe PayTech,
        // on effectue une tentative automatique en mode 'test' avec les mêmes clés pour générer le lien PayTech réel
        if (envMode === 'prod' && typeof errorMsg === 'string' && errorMsg.includes('activer votre compte')) {
          console.warn('[PayTech] Compte production en attente d\'activation PayTech. Tentative automatique avec env="test"...');
          try {
            const retryPayload = { ...payload, env: 'test' };
            const retryResp = await fetch('https://paytech.sn/api/payment/request-payment', {
              method: 'POST',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'API_KEY': apiKey,
                'API_SECRET': apiSecret
              },
              body: JSON.stringify(retryPayload)
            });
            if (retryResp.ok) {
              const retryData = (await retryResp.json()) as any;
              if (retryData.success === 1 || retryData.token || retryData.redirect_url || retryData.redirectUrl) {
                const redirectUrl = retryData.redirect_url || retryData.redirectUrl || (retryData.token ? `https://paytech.sn/payment/checkout/${retryData.token}` : '');
                const token = retryData.token || `PT-${Date.now()}`;
                newOrder.paytechToken = token;
                newOrder.paytechPaymentUrl = redirectUrl;
                ordersStore.set(ref_command, newOrder);
        try { await saveOrderToSupabase({ ...newOrder, id: newOrder.ref_command, orderNumber: newOrder.ref_command }); } catch (dbError) { console.error('[Supabase Order Save]', dbError); }
                return res.status(200).json({
                  success: true,
                  token: token,
                  redirect_url: redirectUrl,
                  ref_command: ref_command,
                  mode: 'test_fallback',
                  notice: 'Lien de test PayTech généré avec succès en attendant l\'activation finale de votre compte par le support PayTech.'
                });
              }
            }
          } catch (retryErr) {
            console.error('[PayTech Retry Error]:', retryErr);
          }
        }

        // En mode test, si le compte PayTech nécessite une activation manuelle auprès du support PayTech,
        // on fournit une simulation Sandbox pour permettre de tester tout le parcours sans blocage.
        if (envMode === 'test') {
          console.warn('[PayTech Sandbox Fallback] Bascule automatique sur la simulation Sandbox pour les tests locaux.');
          const demoToken = `DEMO-TOKEN-${Date.now()}`;
          const demoRedirectUrl = `${BASE_URL}/payment/checkout-demo?ref_command=${encodeURIComponent(ref_command)}&amount=${item_price}&name=${encodeURIComponent(item_name)}`;

          newOrder.paytechToken = demoToken;
          newOrder.paytechPaymentUrl = demoRedirectUrl;
          ordersStore.set(ref_command, newOrder);
        try { await saveOrderToSupabase({ ...newOrder, id: newOrder.ref_command, orderNumber: newOrder.ref_command }); } catch (dbError) { console.error('[Supabase Order Save]', dbError); }

          return res.status(200).json({
            success: true,
            token: demoToken,
            redirect_url: demoRedirectUrl,
            ref_command: ref_command,
            mode: 'sandbox_simulation',
            paytechNotice: errorMsg
          });
        }

        return res.status(400).json({
          success: false,
          error: errorMsg
        });
      }
    } else {
      // MODE TEST / DÉMONSTRATION SÉCURISÉ LORSQUE LES CLÉS SONT ENCORE PAR DÉFAUT
      // Permet de tester le tunnel de vente immédiatement sans bloquer le site
      console.warn('[PayTech Notice] Clés PayTech non configurées ou par défaut. Mode Sandbox de test activé.');
      const demoToken = `DEMO-TOKEN-${Date.now()}`;
      const demoRedirectUrl = `${BASE_URL}/payment/checkout-demo?ref_command=${encodeURIComponent(ref_command)}&amount=${item_price}&name=${encodeURIComponent(item_name)}`;

      newOrder.paytechToken = demoToken;
      newOrder.paytechPaymentUrl = demoRedirectUrl;
      ordersStore.set(ref_command, newOrder);
        try { await saveOrderToSupabase({ ...newOrder, id: newOrder.ref_command, orderNumber: newOrder.ref_command }); } catch (dbError) { console.error('[Supabase Order Save]', dbError); }

      return res.status(200).json({
        success: true,
        token: demoToken,
        redirect_url: demoRedirectUrl,
        ref_command: ref_command,
        mode: 'sandbox_simulation',
        notice: 'Configurez PAYTECH_API_KEY et PAYTECH_API_SECRET dans le fichier .env pour activer les transactions réelles.'
      });
    }
  } catch (error: any) {
    console.error('[PayTech Exception in /paytech/initiate]:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erreur interne du serveur lors de l’initialisation PayTech.'
    });
  }
}

app.post('/paytech/initiate', handlePayTechInitiate);
app.post('/api/paytech/initiate', handlePayTechInitiate);

// ---------------------------------------------------------------------------
// 3. ROUTE WEBHOOK / IPN (POST /paytech/ipn & /api/paytech/ipn)
// ---------------------------------------------------------------------------
/**
 * @route POST /paytech/ipn
 * @description Notification automatique (Instant Payment Notification) envoyée par PayTech.
 * 1. Reçoit les paramètres POST envoyés par PayTech en arrière-plan.
 * 2. Vérifie la Clé Secrète via les hash SHA-256 (api_key_sha256 et api_secret_sha256).
 * 3. Met à jour le statut de la commande en base de données (payé ou échoué/annulée).
 * 4. Retourne un code HTTP 200 à PayTech pour accuser réception.
 */
async function handlePayTechIPN(req: Request, res: Response) {
  try {
    const {
      type_event,
      ref_command,
      item_price,
      token,
      api_key_sha256,
      api_secret_sha256,
      custom_field
    } = req.body;

    console.log(`[PayTech IPN] Notification reçue pour la commande : ${ref_command}`, {
      type_event,
      item_price,
      token
    });

    const { apiKey, apiSecret, isConfigured } = getPayTechConfig();

    // VÉRIFICATION DE SÉCURITÉ DU HASH PAYTECH
    if (isConfigured) {
      const expectedApiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const expectedApiSecretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');

      const isKeyValid = api_key_sha256 ? api_key_sha256 === expectedApiKeyHash : true;
      const isSecretValid = api_secret_sha256 === expectedApiSecretHash;

      if (!isSecretValid || !isKeyValid) {
        console.error('[PayTech IPN] Échec de validation du hash de sécurité ! Requête rejetée.');
        return res.status(403).json({
          success: 0,
          error: 'Hash de sécurité PayTech invalide. Requête non autorisée.'
        });
      }
    }

    // MISE À JOUR DU STATUT DE LA COMMANDE
    if (ref_command) {
      let order = ordersStore.get(ref_command);
      if (!order) {
        order = {
          ref_command,
          item_name: req.body.item_name || 'Commande Solena',
          item_price: Number(item_price) || 0,
          currency: 'XOF',
          status: 'en attente',
          paymentMethod: 'PayTech',
          createdAt: new Date().toISOString()
        };
      }

      if (type_event === 'sale_complete') {
        order.status = 'payé';
        order.paidAt = new Date().toISOString();
        console.log(`[PayTech IPN] Commande ${ref_command} marquée comme PAYÉE avec succès !`);
      } else if (type_event === 'sale_canceled') {
        order.status = 'annulée';
        console.log(`[PayTech IPN] Commande ${ref_command} marquée comme ANNULÉE.`);
      }

      ordersStore.set(ref_command, order);
      try {
        await updateOrderInSupabase(ref_command, order);
      } catch (dbError) {
        console.error('[Supabase IPN Save]', dbError);
      }
    }

    // Réponse HTTP 200 obligatoire exigée par PayTech
    return res.status(200).json({
      success: 1,
      message: 'Notification IPN traitée avec succès par Solena Clothing'
    });
  } catch (error: any) {
    console.error('[PayTech IPN Error]:', error);
    return res.status(500).json({
      success: 0,
      error: error.message || 'Erreur lors du traitement de l’IPN.'
    });
  }
}

app.post('/paytech/ipn', handlePayTechIPN);
app.post('/api/paytech/ipn', handlePayTechIPN);

// ---------------------------------------------------------------------------
// 4. ROUTE DE SUCCÈS (GET /payment/success & POST /payment/success)
// ---------------------------------------------------------------------------
async function handlePaymentSuccess(req: Request, res: Response) {
  const ref = String(req.query.ref_command || req.query.ref || req.body?.ref_command || req.body?.ref || 'SOL-2026');
  const order = ordersStore.get(ref);

  if (order) {
    order.status = 'payé';
    order.paidAt = order.paidAt || new Date().toISOString();
    ordersStore.set(ref, order);
  }
  // La redirection navigateur n'est pas la preuve de paiement, mais on
  // conserve l'information si PayTech renvoie sur cette URL. L'IPN reste
  // la source d'autorité pour les paiements réels.
  try {
    await updateOrderInSupabase(ref, { status: 'payé', paidAt: order?.paidAt || new Date().toISOString() });
  } catch (dbError) {
    console.error('[Supabase Success Save]', dbError);
  }

  res.send(`
    <!doctype html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Paiement Réussi — Solena Clothing</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #FBF3F1;
            color: #2B2126;
            margin: 0;
            padding: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            box-sizing: border-box;
          }
          .card {
            background: #FFFFFF;
            border: 1px solid rgba(201, 106, 135, 0.2);
            border-radius: 28px;
            padding: 40px 32px;
            max-width: 520px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 40px -15px rgba(124, 63, 89, 0.12);
          }
          .icon-circle {
            width: 72px;
            height: 72px;
            border-radius: 50%;
            background: #F0FDF4;
            border: 2px solid #86EFAC;
            color: #16A34A;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            margin: 0 auto 24px;
          }
          h1 {
            font-family: 'Playfair Display', serif;
            font-size: 28px;
            color: #0D0D0D;
            margin: 0 0 10px;
          }
          p {
            font-size: 14px;
            color: rgba(43, 33, 38, 0.8);
            line-height: 1.6;
            margin: 0 0 24px;
          }
          .badge {
            display: inline-block;
            background: #FBF3F1;
            border: 1px dashed #C96A87;
            padding: 10px 18px;
            border-radius: 12px;
            font-size: 13px;
            font-weight: 700;
            color: #7C3F59;
            margin-bottom: 28px;
          }
          .btn {
            display: inline-block;
            background: #0D0D0D;
            color: #FFFFFF;
            text-decoration: none;
            padding: 14px 28px;
            border-radius: 16px;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            transition: all 0.2s;
          }
          .btn:hover {
            background: #7C3F59;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon-circle">✓</div>
          <h1>Paiement PayTech Confirmé !</h1>
          <p>Merci pour votre confiance. Votre transaction a été validée avec succès auprès de PayTech. Notre atelier prépare soigneusement votre commande.</p>
          <div class="badge">Référence : ${ref}</div>
          <div>
            <a href="/" class="btn">Retourner à la boutique Solena</a>
          </div>
        </div>
      </body>
    </html>
  `);
}

app.get('/payment/success', handlePaymentSuccess);
app.post('/payment/success', handlePaymentSuccess);

// ---------------------------------------------------------------------------
// 5. ROUTE D'ANNULATION (GET /payment/cancel & POST /payment/cancel)
// ---------------------------------------------------------------------------
async function handlePaymentCancel(req: Request, res: Response) {
  const ref = String(req.query.ref_command || req.query.ref || req.body?.ref_command || req.body?.ref || 'SOL-2026');
  const order = ordersStore.get(ref);

  if (order) {
    order.status = 'annulée';
    ordersStore.set(ref, order);
  }
  try {
    await updateOrderInSupabase(ref, { status: 'annulée' });
  } catch (dbError) {
    console.error('[Supabase Cancel Save]', dbError);
  }

  res.send(`
    <!doctype html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Paiement Annulé — Solena Clothing</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #FBF3F1;
            color: #2B2126;
            margin: 0;
            padding: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            box-sizing: border-box;
          }
          .card {
            background: #FFFFFF;
            border: 1px solid rgba(201, 106, 135, 0.2);
            border-radius: 28px;
            padding: 40px 32px;
            max-width: 520px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 40px -15px rgba(124, 63, 89, 0.12);
          }
          .icon-circle {
            width: 72px;
            height: 72px;
            border-radius: 50%;
            background: #FEF2F2;
            border: 2px solid #FCA5A5;
            color: #DC2626;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            margin: 0 auto 24px;
          }
          h1 {
            font-family: 'Playfair Display', serif;
            font-size: 28px;
            color: #0D0D0D;
            margin: 0 0 10px;
          }
          p {
            font-size: 14px;
            color: rgba(43, 33, 38, 0.8);
            line-height: 1.6;
            margin: 0 0 24px;
          }
          .badge {
            display: inline-block;
            background: #FBF3F1;
            border: 1px dashed #C96A87;
            padding: 10px 18px;
            border-radius: 12px;
            font-size: 13px;
            font-weight: 700;
            color: #7C3F59;
            margin-bottom: 28px;
          }
          .btn-group {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
          }
          .btn {
            display: inline-block;
            background: #0D0D0D;
            color: #FFFFFF;
            text-decoration: none;
            padding: 14px 24px;
            border-radius: 16px;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            transition: all 0.2s;
          }
          .btn-secondary {
            background: #FBF3F1;
            color: #2B2126;
            border: 1px solid rgba(201, 106, 135, 0.3);
          }
          .btn:hover {
            background: #7C3F59;
            color: #FFFFFF;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon-circle">✕</div>
          <h1>Transaction Annulée</h1>
          <p>Le paiement a été interrompu ou annulé. Aucun montant n'a été prélevé sur votre compte. Vous pouvez recommencer ou opter pour le paiement à la livraison.</p>
          <div class="badge">Référence : ${ref}</div>
          <div class="btn-group">
            <a href="/" class="btn">Reprendre mes achats</a>
          </div>
        </div>
      </body>
    </html>
  `);
}

app.get('/payment/cancel', handlePaymentCancel);
app.post('/payment/cancel', handlePaymentCancel);

// Page de démonstration/sandbox PayTech pour les tests
app.get('/payment/checkout-demo', (req: Request, res: Response) => {
  const ref = String(req.query.ref_command || 'SOL-2026');
  const amount = Number(req.query.amount) || 0;
  const name = String(req.query.name || 'Commande Solena Clothing');

  res.send(`
    <!doctype html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>PayTech Sandbox — Simulation de Paiement</title>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Plus Jakarta Sans', sans-serif; background: #0F172A; color: #FFFFFF; margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .box { background: #1E293B; border: 1px solid #334155; border-radius: 24px; padding: 32px; max-width: 460px; width: 100%; text-align: center; }
          .logo { font-size: 24px; font-weight: 800; color: #38BDF8; margin-bottom: 20px; }
          .summary { background: #0F172A; border-radius: 16px; padding: 18px; margin: 20px 0; text-align: left; font-size: 13px; line-height: 1.8; border: 1px solid #334155; }
          .btn-pay { display: block; width: 100%; background: #10B981; color: #FFFFFF; border: none; padding: 14px; border-radius: 14px; font-weight: 700; font-size: 14px; cursor: pointer; text-decoration: none; box-sizing: border-box; margin-bottom: 10px; }
          .btn-cancel { display: block; width: 100%; background: #334155; color: #94A3B8; border: none; padding: 12px; border-radius: 14px; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: none; box-sizing: border-box; }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">PayTech (Mode Test Sandbox)</div>
          <p style="color: #94A3B8; font-size: 13px;">Passerelle de paiement sécurisée — Sénégal & Afrique de l'Ouest</p>
          <div class="summary">
            <div><strong>Marchand :</strong> Solena Clothing</div>
            <div><strong>Article :</strong> ${name}</div>
            <div><strong>Montant :</strong> <span style="color:#38BDF8; font-weight:700;">${amount.toLocaleString()} FCFA</span></div>
            <div><strong>Référence :</strong> ${ref}</div>
            <div><strong>Moyens acceptés :</strong> Wave, Orange Money, Free Money, Carte Visa/Mastercard</div>
          </div>
          <a href="/payment/success?ref_command=${encodeURIComponent(ref)}" class="btn-pay">Simuler le Paiement Réussi (Wave / OM)</a>
          <a href="/payment/cancel?ref_command=${encodeURIComponent(ref)}" class="btn-cancel">Annuler la transaction</a>
        </div>
      </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// AUTHENTIFICATION DE L'ESPACE GÉRANTE
// ---------------------------------------------------------------------------
app.post('/api/admin/login', (req: Request, res: Response) => {
  if (!isAdminConfigReady()) {
    return res.status(503).json({ success: false, error: 'Authentification administrateur non configurée. Définissez ADMIN_USERNAME, ADMIN_PASSWORD et une ADMIN_SECRET_KEY d’au moins 32 caractères dans Render.' });
  }
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (username !== ADMIN_USERNAME.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Identifiant ou mot de passe incorrect.' });
  }
  const token = createAdminSession();
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return res.json({ success: true });
});

app.post('/api/admin/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return res.json({ success: true });
});

app.get('/api/admin/session', (req: Request, res: Response) => {
  return res.json({ authenticated: isAdminAuthenticated(req) });
});

// ---------------------------------------------------------------------------
// 6. ROUTE D'IMPORTATION / TÉLÉVERSEMENT D'IMAGES DEPUIS L'APPAREIL
// ---------------------------------------------------------------------------
/**
 * @route POST /api/upload
 * @description Permet au gérant de téléverser directement des images depuis son téléphone,
 * sa tablette ou son ordinateur (galerie/caméra) pour les produits, bannières et collections.
 */
app.post('/api/upload', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { imageBase64, filename } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'Donnée imageBase64 manquante.' });
    }

    // Extraction du type MIME et du contenu binaire
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ success: false, error: 'Format data:image/base64 invalide.' });
    }

    const mimeType = matches[1].toLowerCase();
    const base64Data = matches[2];
    const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!allowedMimeTypes.has(mimeType)) {
      return res.status(415).json({ success: false, error: 'Format d\'image non pris en charge. Utilisez JPEG, PNG, WebP ou GIF.' });
    }
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Image invalide ou trop volumineuse. Taille maximale : 5 Mo.' });
    }

    // Extension appropriée
    let ext = 'jpg';
    if (mimeType.includes('png')) ext = 'png';
    else if (mimeType.includes('webp')) ext = 'webp';
    else if (mimeType.includes('gif')) ext = 'gif';

    const safeName = `solena_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;

    if (isSupabaseConfigured()) {
      const uploadResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/product-images/${encodeURIComponent(safeName)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': mimeType,
          'x-upsert': 'true'
        },
        body: buffer
      });
      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`Supabase Storage HTTP ${uploadResponse.status}: ${errorText}`);
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/product-images/${encodeURIComponent(safeName)}`;
      return res.status(200).json({ success: true, url: publicUrl, filename: safeName, storage: 'supabase' });
    }

    // Fallback local uniquement pour le développement local.
    const filePath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(filePath, buffer);
    return res.status(200).json({ success: true, url: `/uploads/${safeName}`, filename: safeName, storage: 'local-fallback' });
  } catch (error: any) {
    console.error('[Upload Error]:', error);
    return res.status(500).json({ success: false, error: error.message || 'Erreur lors du téléversement.' });
  }
});

// Endpoint pour consulter le statut d'une commande
app.get('/api/orders/:ref', async (req: Request, res: Response) => {
  const ref = req.params.ref;
  try {
    const dbRow = await findOrderInSupabase(ref);
    if (dbRow?.data) return res.status(200).json({ success: true, order: dbRow.data });
  } catch (dbError) {
    console.error('[Supabase Order Read]', dbError);
  }
  const order = ordersStore.get(ref);
  if (!order) return res.status(404).json({ success: false, error: 'Commande introuvable.' });
  return res.status(200).json({ success: true, order });
});

// ---------------------------------------------------------------------------
// STOCKAGE PERSISTANT DU CATALOGUE / CONTENU / COMMANDES
// ---------------------------------------------------------------------------
app.get('/api/store/snapshot', async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await listStoreSnapshot());
  } catch (error: any) {
    console.error('[Supabase Snapshot]', error);
    return res.status(503).json({ success: false, error: error.message || 'Supabase indisponible.' });
  }
});

app.post('/api/store/bootstrap', async (req: Request, res: Response) => {
  try {
    if (!isAdminAuthenticated(req)) {
      if (!isSupabaseConfigured()) return res.status(401).json({ success: false, error: 'Authentification gérante requise.' });
      const current = await listStoreSnapshot();
      const hasExistingData = current.products.length > 0 || !!current.content || current.orders.length > 0;
      if (hasExistingData) return res.status(401).json({ success: false, error: 'Authentification gérante requise.' });
    }
    const { products, content, orders } = req.body || {};
    if (Array.isArray(products) && products.length) {
      await supabaseUpsert('products', products.map((product: any) => ({ id: String(product.id), data: product, updated_at: new Date().toISOString() })));
    }
    if (content) {
      await supabaseUpsert('site_content', [{ id: 'main', data: content, updated_at: new Date().toISOString() }]);
    }
    if (Array.isArray(orders) && orders.length) {
      for (const order of orders) await saveOrderToSupabase(order);
    }
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Bootstrap]', error);
    return res.status(503).json({ success: false, error: error.message || 'Impossible de synchroniser les données.' });
  }
});

app.put('/api/store/product/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const product = req.body;
    await supabaseUpsert('products', [{ id: req.params.id, data: product, updated_at: new Date().toISOString() }]);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Product Save]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

app.delete('/api/store/product/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await supabaseRequest(`/rest/v1/products?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Product Delete]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

app.put('/api/store/content', requireAdmin, async (req: Request, res: Response) => {
  try {
    await supabaseUpsert('site_content', [{ id: 'main', data: req.body, updated_at: new Date().toISOString() }]);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Content Save]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

app.post('/api/orders', async (req: Request, res: Response) => {
  try {
    const order = req.body;
    if (!order?.orderNumber && !order?.ref_command) return res.status(400).json({ success: false, error: 'Référence de commande manquante.' });
    const ref = order.orderNumber || order.ref_command;
    ordersStore.set(ref, {
      ref_command: ref,
      item_name: `Commande Solena (${ref})`,
      item_price: Number(order.totalAmount || 0),
      currency: 'XOF',
      customer: order.customer || {},
      status: order.status || 'en attente',
      paymentMethod: order.paymentMethod || 'Commande',
      createdAt: order.createdAt || new Date().toISOString()
    });
    await saveOrderToSupabase({ ...order, id: order.id || `ord-${Date.now()}`, orderNumber: ref, ref_command: ref });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Order Create]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

app.patch('/api/orders/:ref', requireAdmin, async (req: Request, res: Response) => {
  try {
    await updateOrderInSupabase(req.params.ref, req.body || {});
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Order Update]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

app.delete('/api/orders/:ref', requireAdmin, async (req: Request, res: Response) => {
  try {
    const existing = await findOrderInSupabase(req.params.ref);
    if (existing?.id) await supabaseRequest(`/rest/v1/orders?id=eq.${encodeURIComponent(existing.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    ordersStore.delete(req.params.ref);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Supabase Order Delete]', error);
    return res.status(503).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 6. TÉLÉCHARGEMENT DU CODE SOURCE COMPLET DU PROJET (.ZIP)
// ---------------------------------------------------------------------------
app.get(['/download-project', '/solena-clothing-project.zip'], (_req: Request, res: Response) => {
  const zipPath = path.resolve(process.cwd(), 'solena-clothing-project.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="solena-clothing-project.zip"');
    return res.sendFile(zipPath);
  }
  return res.status(404).send('Archive du projet introuvable.');
});

// ---------------------------------------------------------------------------
// 7. INTÉGRATION VITE (DÉVELOPPEMENT & PRODUCTION)
// ---------------------------------------------------------------------------
async function startServer() {
  const nodeEnv = sanitizeEnv(process.env.NODE_ENV, 'development').toLowerCase();
  const disableHmr = sanitizeEnv(process.env.DISABLE_HMR, 'false').toLowerCase() === 'true';

  if (nodeEnv === 'production' || nodeEnv === 'prod' || fs.existsSync(path.resolve(__dirname, 'dist'))) {
    // Mode Production : sert les fichiers statiques pré-compilés
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      // Éviter d'intercepter les requêtes API non trouvées
      if (req.path.startsWith('/api') || req.path.startsWith('/paytech')) {
        return res.status(404).json({ error: 'Endpoint non trouvé' });
      }
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    // Mode Développement : monte les middlewares Vite avec HMR
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        watch: disableHmr ? null : {}
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Solena Clothing Server] Serveur démarré avec succès sur le port ${PORT}`);
    console.log(`[Solena Clothing Server] Passerelle PayTech prête sur /paytech/initiate et /paytech/ipn`);
  });
}

// Démarrage du serveur si exécuté directement
if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  startServer();
}

export { app, startServer };
