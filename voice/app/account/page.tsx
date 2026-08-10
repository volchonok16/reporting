"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppHeader } from "../app-header";
import { AuthUser, useAuth } from "../auth-provider";

function responseError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const detail = (payload as { detail?: { message?: unknown } }).detail;
    if (typeof detail?.message === "string") return detail.message;
  }
  return fallback;
}

export default function AccountPage() {
  const { user, authorizedFetch, refreshUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"standard" | "superuser">("standard");
  const [canAccessMaster, setCanAccessMaster] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const loadUsers = useCallback(async () => {
    if (user?.role !== "superuser") return;
    const response = await authorizedFetch("/api/auth/users");
    const payload = await response.json().catch(() => null);
    if (response.ok)
      setUsers(Array.isArray(payload?.items) ? payload.items : []);
  }, [authorizedFetch, user?.role]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadUsers(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadUsers]);

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const response = await authorizedFetch("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        role,
        canAccessMaster: role === "superuser" || canAccessMaster,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(responseError(payload, "Не удалось создать пользователя."));
    } else {
      setEmail("");
      setPassword("");
      setRole("standard");
      setCanAccessMaster(false);
      setNotice("Пользователь создан. Почта уже является его логином.");
      await loadUsers();
    }
    setSaving(false);
  };

  const updateUser = async (
    target: AuthUser,
    patch: Record<string, unknown>,
  ) => {
    setError("");
    setNotice("");
    const response = await authorizedFetch(`/api/auth/users/${target.id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(responseError(payload, "Не удалось изменить пользователя."));
      return;
    }
    setNotice("Права пользователя обновлены.");
    await loadUsers();
    if (target.id === user?.id) await refreshUser();
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const response = await authorizedFetch("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(responseError(payload, "Не удалось изменить пароль."));
    } else {
      setCurrentPassword("");
      setNewPassword("");
      setNotice("Пароль изменён.");
    }
    setSaving(false);
  };

  return (
    <main className="app-shell">
      <AppHeader />
      <div className="workspace account-workspace">
        <section className="account-hero">
          <div>
            <p className="eyebrow">Личный кабинет</p>
            <h1>{user?.email}</h1>
            <p>
              {user?.role === "superuser"
                ? "Суперюзер · полный доступ и управление пользователями"
                : `Стандартный пользователь · ${
                    user?.canAccessMaster
                      ? "доступ к мастер-файлу разрешён"
                      : "без доступа к мастер-файлу"
                  }`}
            </p>
          </div>
          <span className="account-role">
            {user?.role === "superuser" ? "Суперюзер" : "Стандартный"}
          </span>
        </section>

        {error && <div className="master-alert is-error">{error}</div>}
        {notice && <div className="master-alert is-success">{notice}</div>}

        <section className="card account-password-card">
          <div className="section-heading">
            <div>
              <span className="section-index">01</span>
              <div>
                <h2>Сменить пароль</h2>
                <p>Пароль должен содержать не менее 8 символов, буквы и цифры.</p>
              </div>
            </div>
          </div>
          <form className="account-password-form" onSubmit={changePassword}>
            <label className="field">
              <span>Текущий пароль</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field">
              <span>Новый пароль</span>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={saving}
            >
              Изменить пароль
            </button>
          </form>
        </section>

        {user?.role === "superuser" && (
          <>
            <section className="card account-create-card">
              <div className="section-heading">
                <div>
                  <span className="section-index">02</span>
                  <div>
                    <h2>Создать пользователя</h2>
                    <p>
                      Стандартный пользователь изначально получает только
                      обработку заявок.
                    </p>
                  </div>
                </div>
              </div>
              <form className="account-create-form" onSubmit={createUser}>
                <label className="field">
                  <span>Почта / логин</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Начальный пароль</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    required
                  />
                </label>
                <label className="field">
                  <span>Роль</span>
                  <select
                    value={role}
                    onChange={(event) => {
                      const nextRole = event.target.value as
                        | "standard"
                        | "superuser";
                      setRole(nextRole);
                      if (nextRole === "standard") setCanAccessMaster(false);
                    }}
                  >
                    <option value="standard">Стандартный пользователь</option>
                    <option value="superuser">Суперюзер</option>
                  </select>
                </label>
                <label className="master-check">
                  <input
                    type="checkbox"
                    checked={role === "superuser" || canAccessMaster}
                    disabled={role === "superuser"}
                    onChange={(event) =>
                      setCanAccessMaster(event.target.checked)
                    }
                  />
                  Разрешить доступ к мастер-файлу
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={saving}
                >
                  Создать пользователя
                </button>
              </form>
            </section>

            <section className="card account-users-card">
              <div className="section-heading">
                <div>
                  <span className="section-index">03</span>
                  <div>
                    <h2>Пользователи и доступы</h2>
                    <p>Изменения применяются сразу после подтверждения.</p>
                  </div>
                </div>
              </div>
              <div className="account-users-list">
                {users.map((target) => (
                  <article key={target.id}>
                    <div>
                      <strong>{target.email}</strong>
                      <span>
                        {target.role === "superuser"
                          ? "Суперюзер"
                          : "Стандартный пользователь"}
                      </span>
                    </div>
                    <label className="master-check">
                      <input
                        type="checkbox"
                        checked={target.canAccessMaster}
                        disabled={target.role === "superuser"}
                        onChange={(event) =>
                          void updateUser(target, {
                            canAccessMaster: event.target.checked,
                          })
                        }
                      />
                      Мастер файл
                    </label>
                    <label className="master-check">
                      <input
                        type="checkbox"
                        checked={target.isActive}
                        disabled={target.id === user.id}
                        onChange={(event) =>
                          void updateUser(target, {
                            isActive: event.target.checked,
                          })
                        }
                      />
                      Активен
                    </label>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
