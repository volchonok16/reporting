"use client";

import { AppHeader } from "../app-header";
import { useAuth } from "../auth-provider";

export default function AccountPage() {
  const { user } = useAuth();

  return (
    <main className="app-shell">
      <AppHeader />
      <div className="workspace account-workspace">
        <section className="account-hero">
          <div>
            <p className="eyebrow">Личный кабинет</p>
            <h1>{user?.email}</h1>
            <p>
              Вход выполнен через reporting. Управление учётными записями и
              паролями — в основном приложении, не в Voice.
            </p>
          </div>
          <span className="account-role">
            {user?.role === "superuser" ? "Админ reporting" : "Пользователь"}
          </span>
        </section>
      </div>
    </main>
  );
}
