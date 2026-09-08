import type { CapacitorConfig } from '@capacitor/cli';

// Espace Apps — coquille mobile native (Capacitor).
//
// CHANGEMENT PAR RAPPORT À AVANT : l'app ne pointe plus directement vers
// https://uplinksafrica.com/apps/ (server.url). Elle démarre maintenant sur
// une petite page embarquée dans l'app elle-même (dossier "www/") qui :
//   - s'il y a du réseau : synchronise ce qui a été fait hors-ligne puis
//     affiche votre site exactement comme avant (aucun changement d'usage
//     au quotidien, et les mises à jour du PHP sur le serveur continuent de
//     s'appliquer sans jamais recompiler l'app) ;
//   - s'il n'y en a pas : affiche les tâches déjà en cache et permet de
//     clôturer une tâche (actions, signature, note), envoyée automatiquement
//     dès le retour du réseau.
// Ce changement demande UNE SEULE recompilation (voir LISEZ-MOI). Ensuite,
// comme avant, les mises à jour du PHP ne demandent aucune recompilation —
// sauf si la page hors-ligne elle-même (dossier www/) doit un jour changer.
//
// allowNavigation : sans ça, une fois revenu en ligne, l'app quitte
// uplinksafrica.com vers le navigateur externe au lieu de rester dans
// l'app — car ce domaine n'est plus "l'origine" de l'app comme avant
// (quand server.url pointait dessus directement). On l'autorise donc
// explicitement à s'afficher DANS l'app.
const config: CapacitorConfig = {
  appId: 'com.uplinksafrica.trousseau',
  appName: 'Uplinks Apps',
  webDir: 'www',
  android: {
    // Origine locale en https (évite les avertissements de contenu mixte
    // lors des appels vers l'API, elle-même en https).
  },
  server: {
    androidScheme: 'https',
    allowNavigation: ['uplinksafrica.com', 'www.uplinksafrica.com'],
  },
  ios: {
    contentInset: 'automatic'
  }
};

export default config;
