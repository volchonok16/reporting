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

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/$/, "");
const TOKEN_KEY = "carousel-auth-token";
const EMBED_KEY = "carousel-reporting-embed";
const AuthContext = createContext<AuthContextValue | null>(null);

function storedToken() {
  return typeof localStorage === "undefined"
    ? ""
    : localStorage.getItem(TOKEN_KEY) || "";
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

function takeReportingSsoFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reportingSso") || "";
  if (params.get("embed") === "1") {
    window.sessionStorage.setItem(EMBED_KEY, "1");
  }
  if (token) {
    params.delete("reportingSso");
    const next = `${window.location.pathname}${
      params.toString() ? `?${params.toString()}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
  return token;
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

  const refreshUser = useCallback(async () => {
    const token = storedToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const response = await authorizedFetch("/api/auth/me");
      if (!response.ok) {
        setUser(null);
        return;
      }
      const payload = await response.json();
      setUser(payload.user as AuthUser);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [authorizedFetch]);

  useEffect(() => {
    setEmbedded(readEmbedFlag());
    const ssoToken = takeReportingSsoFromUrl();
    setEmbedded(readEmbedFlag());

    let cancelled = false;
    const boot = async () => {
      if (ssoToken) {
        setLoading(true);
        try {
          const response = await fetch(`${API_BASE}/api/auth/reporting-sso`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: ssoToken }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            const message =
              payload?.detail?.message ||
              payload?.detail ||
              "Не удалось войти через reporting";
            if (!cancelled) {
              setSsoError(String(message));
              setUser(null);
              setLoading(false);
            }
            return;
          }
          if (!cancelled) {
            completeLogin(payload.token as string, payload.user as AuthUser);
            if (window.location.pathname === "/login") router.replace("/");
          }
          return;
        } catch {
          if (!cancelled) {
            setSsoError("Сервер Voice недоступен");
            setLoading(false);
          }
          return;
        }
      }
      await refreshUser();
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [completeLogin, refreshUser, router]);

  useEffect(() => {
    if (loading) return;
    if (embedded) return;
    if (pathname !== "/login" && !user) {
      router.replace("/login");
      return;
    }
    if (pathname === "/master" && user && !user.canAccessMaster)
      router.replace("/account");
  }, [embedded, loading, pathname, router, user]);

  const logout = useCallback(async () => {
    try {
      await authorizedFetch("/api/auth/logout", { method: "POST" });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      if (readEmbedFlag()) {
        setSsoError("Сессия Voice завершена. Выйдите и войдите снова в reporting.");
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
    pathname === "/master" && user && !user.canAccessMaster;

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
      {protectedPath && (loading || !user || masterDenied) ? (
        <main className="auth-loading">
          <span className="brand-mark" aria-hidden="true">
            t2
          </span>
          <strong>
            {masterDenied
              ? "Проверяем доступ…"
              : embedded
                ? "Входим через reporting…"
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
