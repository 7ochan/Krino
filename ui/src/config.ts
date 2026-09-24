// All API traffic uses the Vite /api proxy in development. A deployed local UI
// can set VITE_API_BASE_URL without spreading host/port assumptions in views.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
