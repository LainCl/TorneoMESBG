/**
 * CONFIGURACIÓN DE SINCRONIZACIÓN EN VIVO (FIREBASE REALTIME DATABASE)
 *
 * Para que todos los jugadores vean el torneo desde cualquier celular sin configurar nada:
 * 1. Pega aquí abajo la URL de tu Firebase Realtime Database en `FIREBASE_DB_URL`
 *    (ejemplo: "https://torneo-mesbg-default-rtdb.firebaseio.com")
 *    o configúrala directamente desde el botón "🔒 Organizador" dentro de la aplicación.
 */
window.MESBG_CLOUD_CONFIG = {
  // URL de tu Firebase Realtime Database (conectada por defecto para todos los dispositivos)
  FIREBASE_DB_URL: 'https://torneomesbg-default-rtdb.firebaseio.com',

  // Clave / PIN para desbloquear el Modo Organizador (crear torneo, emparejar y editar puntajes)
  ADMIN_PIN: 'deazul2026'
};
