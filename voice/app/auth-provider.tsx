"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type AuthUser = {
  id: string;
  email: string;
  role: "superuser" | "standard";
  canAccessMaster: boolean;
  isActive: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  embedded: boolean;
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  completeLogin: (token: string, user: AuthUser) => void;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
};

const API_BASE = (() => {
  const fromEnv = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  if (fromEnv && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(fromEnv)) {
    return fromEnv;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}/voice-api`;
  }
  return "http://127.0.0.1:8100";
})();
const TOKEN_KEY = "carousel-auth-token";
const EMBED_KEY = "carousel-reporting-embed";
const THEME_KEY = "carousel-reporting-theme";
const AUTH_FETCH_MS = 8000;
const AuthContext = createContext<AuthContextValue | null>(null);

function storedToken() {
  return typeof localStorage === "undefined"
    ? ""
    : localStorage.getItem(TOKEN_KEY) || "";
}

function applyTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function takeReportingBootstrapFromUrl(): { sso: string; theme: "light" | "dark" | null } {
  if (typeof window === "undefined") return { sso: "", theme: null };
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reportingSso") || "";
  const themeParam = params.get("theme");
  const theme =
    themeParam === "dark" || themeParam === "light" ? themeParam : null;
  if (params.get("embed") === "1") {
    window.sessionStorage.setItem(EMBED_KEY, "1");
  }
  if (theme) {
    window.sessionStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  } else {
    const stored = window.sessionStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") applyTheme(stored);
  }
  if (token || theme || params.get("embed") === "1") {
    params.delete("reportingSso");
    params.delete("theme");
    const next = `${window.location.pathname}${
      params.toString() ? `?${params.toString()}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
  return { sso: token, theme };
}

function readEmbedFlag() {
  if (typeof window === "undefined") return false;
  if (window.sessionStorage.getItem(EMBED_KEY) === "1") return true;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function detailMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = AUTH_FETCH_MS,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  } finally {
    window.clearTimeout(timer);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [embedded, setEmbedded] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  const authorizedFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = storedToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (
        init.body &&
        !(init.body instanceof FormData) &&
        !headers.has("Content-Type")
      )
        headers.set("Content-Type", "application/json");
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
      });
      if (
        response.status === 401 &&
        !path.endsWith("/auth/login") &&
        !path.endsWith("/auth/reporting-sso")
      ) {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        if (!readEmbedFlag()) router.replace("/login");
      }
      return response;
    },
    [router],
  );

  const completeLogin = useCallback((token: string, nextUser: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, token);
    setUser(nextUser);
    setLoading(false);
    setSsoError(null);
  }, []);

  const restoreExistingSession = useCallback(async (): Promise<boolean> => {
    const token = storedToken();
    if (!token) return false;
    try {
      const result = await fetchJson(`${API_BASE}/api/auth/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok || !result.payload || typeof result.payload !== "object") {
        localStorage.removeItem(TOKEN_KEY);
        return false;
      }
      const nextUser = (result.payload as { user?: AuthUser }).user;
      if (!nextUser) {
        localStorage.removeItem(TOKEN_KEY);
        return false;
      }
      setUser(nextUser);
      setSsoError(null);
      setLoading(false);
      return true;
    } catch {
      // Сеть/таймаут: токен оставляем — ниже попробуем SSO или покажем ошибку.
      return false;
    }
  }, []);

  const exchangeReportingSso = useCallback(
    async (ssoToken: string): Promise<boolean> => {
      try {
        const result = await fetchJson(`${API_BASE}/api/auth/reporting-sso`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ssoToken }),
        });
        if (!result.ok) {
          setSsoError(
            detailMessage(result.payload, "Не удалось войти через reporting"),
          );
          return false;
        }
        const payload = result.payload as { token?: string; user?: AuthUser };
        if (!payload.token || !payload.user) {
          setSsoError("Сервер Voice не вернул сессию");
          return false;
        }
        completeLogin(payload.token, payload.user);
        const path = window.location.pathname.replace(/\/$/, "");
        if (path.endsWith("/login")) router.replace("/");
        return true;
      } catch {
        setSsoError("Сервер Voice недоступен");
        return false;
      }
    },
    [completeLogin, router],
  );

  const refreshUser = useCallback(async () => {
    const restored = await restoreExistingSession();
    if (!restored) {
      setUser(null);
      setLoading(false);
    }
  }, [restoreExistingSession]);

  useEffect(() => {
    setEmbedded(readEmbedFlag());
    const { sso: ssoFromUrl } = takeReportingBootstrapFromUrl();
    setEmbedded(readEmbedFlag());

    let cancelled = false;
    let ssoFromParent: string | null = null;

    const onParentMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "reporting-sso" && typeof data.token === "string") {
        ssoFromParent = data.token;
      }
      if (data.type === "reporting-theme") {
        if (data.theme === "dark" || data.theme === "light") {
          window.sessionStorage.setItem(THEME_KEY, data.theme);
          applyTheme(data.theme);
        }
      }
    };
    window.addEventListener("message", onParentMessage);

    const boot = async () => {
      const isEmbed = readEmbedFlag();

      // Уже есть сессия Voice — не гоняем повторный SSO (пользователь уже в reporting).
      if (storedToken()) {
        const restored = await restoreExistingSession();
        if (cancelled) return;
        if (restored) return;
      }

      const ssoToken = ssoFromUrl || ssoFromParent;
      if (ssoToken) {
        const ok = await exchangeReportingSso(ssoToken);
        if (cancelled) return;
        if (!ok) setLoading(false);
        return;
      }

      if (isEmbed) {
        // Попросим reporting отдать SSO один раз, без отдельного логина Voice.
        try {
          window.parent.postMessage({ type: "voice-auth-required" }, "*");
        } catch {
          /* ignore */
        }
        const deadline = Date.now() + AUTH_FETCH_MS;
        while (Date.now() < deadline && !cancelled) {
          if (ssoFromParent) {
            const ok = await exchangeReportingSso(ssoFromParent);
            if (cancelled) return;
            if (!ok) setLoading(false);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        if (cancelled) return;
        setSsoError(
          "Reporting не передал сессию в Voice. Обновите вкладку Voice.",
        );
        setLoading(false);
        return;
      }

      await refreshUser();
    };

    void boot();
    return () => {
      cancelled = true;
      window.removeEventListener("message", onParentMessage);
    };
  }, [exchangeReportingSso, refreshUser, restoreExistingSession]);

  useEffect(() => {
    if (loading) return;
    if (embedded) return;
    if (pathname !== "/login" && !user) {
      router.replace("/login");
      return;
    }
    if (pathname === "/master" && user && !user.canAccessMaster)
      router.replace("/");
    if (pathname === "/account") router.replace("/");
  }, [embedded, loading, pathname, router, user]);

  const logout = useCallback(async () => {
    try {
      await authorizedFetch("/api/auth/logout", { method: "POST" });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      if (readEmbedFlag()) {
        setSsoError(
          "Сессия Voice завершена. Выйдите и войдите снова в reporting.",
        );
      } else {
        router.replace("/login");
      }
    }
  }, [authorizedFetch, router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      embedded,
      authorizedFetch,
      completeLogin,
      refreshUser,
      logout,
    }),
    [
      authorizedFetch,
      completeLogin,
      embedded,
      loading,
      logout,
      refreshUser,
      user,
    ],
  );

  const protectedPath = pathname !== "/login";
  const masterDenied =
    pathname === "/master" && Boolean(user && !user.canAccessMaster);
  // В embed не показываем «Проверяем авторизацию» — пользователь уже вошёл в reporting.
  const blockForAuth =
    protectedPath &&
    (masterDenied ||
      (embedded ? loading && !user : loading || !user));

  if (ssoError && embedded) {
    return (
      <main className="auth-loading">
        <span className="brand-mark" aria-hidden="true">
          t2
        </span>
        <strong>Voice</strong>
        <p>{ssoError}</p>
        <p>Откройте вкладку Voice заново из reporting.</p>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={value}>
      {blockForAuth ? (
        <main className="auth-loading">
          <span className="brand-mark" aria-hidden="true">
            t2
          </span>
          <strong>
            {masterDenied
              ? "Нет доступа к этому разделу"
              : embedded
                ? "Открываем Voice…"
                : "Проверяем авторизацию…"}
          </strong>
        </main>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export { API_BASE };
