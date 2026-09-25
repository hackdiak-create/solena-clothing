# Solena Clothing — Boutique E-Commerce & Passerelle PayTech

Boutique en ligne moderne haute couture pour **Solena Clothing**, intégrant la passerelle de paiement **PayTech Sénégal** (Wave, Orange Money, Free Money, Carte bancaire) et la commande rapide via WhatsApp.

---

## 🚀 Démarrage Rapide

### 1. Prérequis
- [Node.js](https://nodejs.org/) (version 18 ou supérieure recommandée)
- `npm` ou `yarn` ou `pnpm`

### 2. Installation des dépendances
```bash
npm install
```

### 3. Configuration des variables d'environnement
Créez ou modifiez le fichier `.env` à la racine du projet :

```env
# Port du serveur local (par défaut : 3000)
PORT=3000

# URL de base publique (en local ou sur votre hébergeur : Render, Vercel, Railway, VPS...)
# Exemples :
# En local : http://localhost:3000
# En production : https://votre-site.com
BASE_URL="http://localhost:3000"

# =========================================================================
# CONFIGURATION PASSERELLE PAYTECH SÉNÉGAL (paytech.sn)
# Vos clés sont disponibles sur votre tableau de bord PayTech > Paramètres > API
# =========================================================================
PAYTECH_API_KEY="votre_cle_api_publique"
PAYTECH_API_SECRET="votre_cle_api_secrete"

# "prod" pour accepter les paiements réels, "test" pour l'environnement sandbox
PAYTECH_ENV="prod"
```

### 4. Lancement en mode développement
```bash
npm run dev
```
Rendez-vous ensuite sur [http://localhost:3000](http://localhost:3000) dans votre navigateur.

### 5. Construction pour la production
```bash
npm run build
npm start
```

---

## 🛠 Architecture & Routes Principales

- `server.ts` : Serveur Express / Node.js avec les routes PayTech et l'intégration Vite :
  - `POST /paytech/initiate` et `POST /api/paytech/initiate` : Initialisation dynamique de la transaction PayTech
  - `POST /api/paytech/ipn` et `POST /paytech/ipn` : Webhook instantané avec vérification cryptographique SHA-256
  - `GET /payment/success` : Page de confirmation de paiement
  - `GET /payment/cancel` : Page d'annulation sécurisée
  - `GET /download-project` : Téléchargement de l'archive ZIP du projet
- `src/` : Application React avec Tailwind CSS, interface catalogue, panier, commande mobile optimisée et gestion de boutique.
- `public/` : Ressources statiques, logos haute résolution et images.

## ☁️ Déploiement Render + Supabase

Le backend utilise Supabase pour rendre persistants :
- le catalogue produits ;
- le contenu éditable du site ;
- les commandes et leur état de paiement ;
- les images téléversées dans le bucket `product-images`.

Variables serveur à définir dans Render (ne pas les mettre dans le frontend) :
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAYTECH_API_KEY`
- `PAYTECH_API_SECRET`
- `PAYTECH_ENV`
- `BASE_URL`
- `PORT` (Render peut fournir automatiquement le port ; le serveur utilise 3000 par défaut)

Health check : `GET /health`.

Le fichier `supabase_schema.sql` contient le schéma appliqué au projet Supabase.

### Configuration Render recommandée

Dans Render, configurez :
- **Build Command** : `npm install && npm run build`
- **Start Command** : `npm start`
- **Health Check Path** : `/health`
- **Node.js** : 20.19+ (ou une version plus récente compatible avec Vite 8)

Variables d'environnement supplémentaires pour l'espace gérante :
- `ADMIN_USERNAME` — identifiant de connexion
- `ADMIN_PASSWORD` — mot de passe de connexion
- `ADMIN_SECRET_KEY` — secret aléatoire d'au moins 32 caractères, utilisé pour signer la session HTTP-only

Ne committez jamais `.env` ni une vraie `SUPABASE_SERVICE_ROLE_KEY`, `PAYTECH_API_SECRET`, `ADMIN_PASSWORD` ou `ADMIN_SECRET_KEY` dans GitHub.

### Édition de la vitrine

Depuis l'espace gérante, les textes de bannière et les paramètres de boutique sont persistés automatiquement dans Supabase. Les images importées depuis l'appareil sont compressées côté navigateur puis téléversées dans Supabase Storage ; la vitrine conserve ensuite l'URL publique de l'image au lieu d'enregistrer un gros Base64 dans PostgreSQL.
