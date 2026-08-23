"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-provider";

export default function LoginPage() {
  const router = useRouter();
  const { user } = useAuth();

  useEffect(() => {
    if (user) {
      router.replace("/");
      return;
    }
    router.replace("/");
  }, [router, user]);

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-copy">
          <p className="eyebrow">Авторизация</p>
          <h1>Вход через reporting</h1>
          <p>
            Откройте Voice из основного приложения reporting — отдельный логин
            карусели не используется.
          </p>
        </div>
      </section>
    </main>
  );
}
