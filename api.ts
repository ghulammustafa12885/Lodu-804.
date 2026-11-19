import { Capacitor } from '@capacitor/core';

const FALLBACK_WEB_ORIGIN =
  typeof window !== 'undefined' &&
  window.location.protocol !== 'capacitor:' &&
  window.location.hostname !== 'localhost'
    ? window.location.origin
    : '';

function parseValidUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeBackendConfigured(): boolean {
  const configured = import.meta.env.VITE_API_URL?.trim() || '';
  if (!isNativeApp()) {
    if (!configured) return true;
    const parsed = parseValidUrl(configured);
    if (!parsed) return false;
    if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
      return parsed.protocol === 'https:';
    }
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  }

  // Signed Android APK strictly requires a real HTTPS backend URL
  const parsed = parseValidUrl(configured);
  if (!parsed || parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return false;
  return true;
}

export function getBackendConfigError(): string | null {
  const configured = import.meta.env.VITE_API_URL?.trim() || '';
  if (isNativeApp()) {
    if (!configured) {
      return 'Missing VITE_API_URL: configure a live HTTPS backend URL before Play Store release.';
    }
    const parsed = parseValidUrl(configured);
    if (!parsed || parsed.protocol !== 'https:') {
      return 'Invalid VITE_API_URL: Android APK strictly requires HTTPS (https://...).';
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return 'Invalid VITE_API_URL: localhost is unreachable from Android devices.';
    }
    return null;
  }

  if (configured) {
    const parsed = parseValidUrl(configured);
    if (!parsed) return 'Invalid VITE_API_URL format.';
    if (
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      parsed.protocol !== 'https:'
    ) {
      return 'Mixed content blocked: VITE_API_URL must use HTTPS on HTTPS sites.';
    }
  }
  return null;
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) {
    if (!isNativeBackendConfigured()) return '';
    return configured.replace(/\/+$/, '');
  }
  if (isNativeApp()) {
    return '';
  }
  if (typeof window !== 'undefined') {
    return FALLBACK_WEB_ORIGIN;
  }
  return '';
}

export function getApiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export function getWsUrl(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) {
    if (!isNativeBackendConfigured()) return '';
    const clean = configured.replace(/\/+$/, '');
    if (clean.startsWith('https://')) {
      return clean.replace('https://', 'wss://');
    }
    if (clean.startsWith('http://')) {
      return clean.replace('http://', 'ws://');
    }
    return clean;
  }
  if (isNativeApp()) {
    return '';
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return 'ws://localhost:3000';
}
