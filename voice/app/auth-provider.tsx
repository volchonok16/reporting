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
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  completeLogin: (token: string, user: AuthUser) => void;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
};

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/$/, "");
const TOKEN_KEY = "carousel-auth-token";
const AuthContext = createContext<AuthContextValue | null>(null);

function storedToken() {
  return typeof localStorage === "undefined"
    ? ""
    : localStorage.getItem(TOKEN_KEY) || "";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

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
      if (response.status === 401 && !path.endsWith("/auth/login")) {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        router.replace("/login");
      }
      return response;
    },
    [router],
  );

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
    const timeout = window.setTimeout(() => void refreshUser(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshUser]);

  useEffect(() => {
    if (loading) return;
    if (pathname !== "/login" && !user) {
      router.replace("/login");
      return;
    }
    if (pathname === "/master" && user && !user.canAccessMaster)
      router.replace("/account");
  }, [loading, pathname, router, user]);

  const completeLogin = useCallback((token: string, nextUser: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, token);
    setUser(nextUser);
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authorizedFetch("/api/auth/logout", { method: "POST" });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      router.replace("/login");
    }
  }, [authorizedFetch, router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      authorizedFetch,
      completeLogin,
      refreshUser,
      logout,
    }),
    [
      authorizedFetch,
      completeLogin,
      loading,
      logout,
      refreshUser,
      user,
    ],
  );

  const protectedPath = pathname !== "/login";
  const masterDenied =
    pathname === "/master" && user && !user.canAccessMaster;

  return (
    <AuthContext.Provider value={value}>
      {protectedPath && (loading || !user || masterDenied) ? (
        <main className="auth-loading">
          <span className="brand-mark" aria-hidden="true">
            t2
          </span>
          <strong>
            {masterDenied ? "Проверяем доступ…" : "Проверяем авторизацию…"}
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
