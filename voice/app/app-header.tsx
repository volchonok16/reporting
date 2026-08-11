"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MouseEvent } from "react";
import { useAuth } from "./auth-provider";

type AppHeaderProps = {
  onBeforeNavigate?: () => boolean | void | Promise<boolean | void>;
};

export function AppHeader({ onBeforeNavigate }: AppHeaderProps = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, embedded, ready } = useAuth();

  const navigateAfterCleanup =
    (href: string) => async (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        !onBeforeNavigate ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (href === pathname) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const canNavigate = await onBeforeNavigate();
      if (canNavigate === false) return;
      router.push(href);
    };

  return (
    <header className="topbar">
      <Link
        className="brand"
        href="/"
        prefetch={false}
        onClick={navigateAfterCleanup("/")}
        aria-label="Агент мобильной карусели — главная"
      >
        <span className="brand-mark" aria-hidden="true">
          t2
        </span>
        <span>
          <strong>Агент мобильной карусели</strong>
          <small>Управление опорными номерами и АОН</small>
        </span>
      </Link>
      <div className="topbar-actions">
        <nav className="topbar-nav" aria-label="Разделы приложения">
          <Link
            className={`topbar-link ${pathname === "/" ? "is-active" : ""}`}
            href="/"
            prefetch={false}
            onClick={navigateAfterCleanup("/")}
          >
            Обработка заявок
          </Link>
          {ready && user?.canAccessMaster ? (
            <Link
              className={`topbar-link ${
                pathname === "/master" ? "is-active" : ""
              }`}
              href="/master"
              prefetch={false}
              onClick={navigateAfterCleanup("/master")}
            >
              Мастер файл
            </Link>
          ) : null}
        </nav>
        {ready && !embedded ? (
          <button
            className="account-logout"
            type="button"
            onClick={() =>
              void (async () => {
                const canLeave = await onBeforeNavigate?.();
                if (canLeave === false) return;
                await logout();
              })()
            }
          >
            Выйти
          </button>
        ) : null}
      </div>
    </header>
  );
}
