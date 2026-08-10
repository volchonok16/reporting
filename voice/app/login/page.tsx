"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE, AuthUser, useAuth } from "../auth-provider";

function errorMessage(payload: unknown) {
  if (payload && typeof payload === "object") {
    const detail = (payload as { detail?: { message?: unknown } }).detail;
    if (typeof detail?.message === "string") return detail.message;
  }
  return "Не удалось войти. Проверьте почту и пароль.";
}

function destinationAfterLogin(user: AuthUser) {
  if (
    user.canAccessMaster &&
    typeof localStorage !== "undefined" &&
    localStorage.getItem(`carousel-master-draft:${user.id}`)
  )
    return "/master";
  return "/";
}

export default function LoginPage() {
  const router = useRouter();
  const { user, completeLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) router.replace(destinationAfterLogin(user));
  }, [router, user]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(payload));
        return;
      }
      const nextUser = payload.user as AuthUser;
      completeLogin(payload.token as string, nextUser);
      router.replace(destinationAfterLogin(nextUser));
    } catch {
      setError("Сервер авторизации недоступен.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            t2
          </span>
          <div>
            <strong>Агент мобильной карусели</strong>
            <span>Закрытый рабочий контур</span>
          </div>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Авторизация</p>
          <h1>Войдите в приложение</h1>
          <p>
            Используйте почту и пароль, выданные суперюзером. Почта является
            логином.
          </p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span>Почта</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              placeholder="user@company.ru"
              required
            />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Не менее 8 символов"
              required
              minLength={8}
            />
          </label>
          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}
          <button
            className="primary-button"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Входим…" : "Войти"}
          </button>
        </form>
        <small className="login-security">
          Все данные и учётные записи хранятся только в локальном приложении.
        </small>
      </section>
    </main>
  );
}
