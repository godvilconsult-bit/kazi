"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useAccount, useSwitchChain } from "wagmi";
import { KeyRound, Languages, LogOut, Menu, Moon, Sparkles, Sun, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { shortAddress } from "@/lib/format";
import { useAuth } from "./auth";
import { useKaziConfig } from "./config";
import { Container } from "./container";
import { Logo } from "./logo";
import { NotificationsBell } from "./notifications-bell";
import { Button } from "./ui";
import { ConnectWalletButton } from "./wallet";

export function Header() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { user, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const links = [
    { href: "/agents", label: t("agents"), show: true },
    { href: "/developers", label: t("developers"), show: !user },
    { href: "/tasks", label: t("myTasks"), show: Boolean(user) },
    { href: "/provider", label: t("provide"), show: Boolean(user) },
    { href: "/freelancer/offers", label: t("offers"), show: Boolean(user?.roles.includes("FREELANCER")) },
    { href: "/admin", label: t("admin"), show: isAdmin },
  ].filter((l) => l.show);

  return (
    <>
      <Banners />
      <header className="sticky top-0 z-40 border-b border-ink/15 bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75">
        <Container className="flex h-16 items-center gap-3">
          <Link href="/" className="shrink-0 rounded-md" aria-label={t("home")}>
            <Logo />
          </Link>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.href} href={l.href} label={l.label} active={pathname.startsWith(l.href)} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <Link
              href="/new"
              className="hidden h-9 items-center rounded-lg border border-ink bg-accent px-3 text-sm font-semibold text-accent-ink shadow-stamp-sm transition-all hover:shadow-stamp sm:inline-flex"
            >
              {t("newTask")}
            </Link>
            <div className="hidden items-center md:flex">
              <LocaleSwitch />
              <ThemeToggle />
            </div>
            {user ? <NotificationsBell /> : null}
            <WalletButton />
            <button
              type="button"
              className="rounded-lg p-2 hover:bg-surface-2 md:hidden"
              aria-label={t("menu")}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </Container>
        {open ? (
          <div className="border-t border-line bg-surface md:hidden">
            <Container className="flex flex-col gap-1 py-3">
              <NavLink href="/new" label={t("newTask")} active={pathname === "/new"} />
              {links.map((l) => (
                <NavLink key={l.href} href={l.href} label={l.label} active={pathname.startsWith(l.href)} />
              ))}
              <NavLink href="/get-usdc" label={t("getUsdc")} active={pathname === "/get-usdc"} />
              <div className="mt-2 flex items-center gap-2 border-t border-dashed border-line pt-3">
                <LocaleSwitch />
                <ThemeToggle />
              </div>
            </Container>
          </div>
        ) : null}
      </header>
    </>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
        active ? "bg-ink text-bg" : "text-ink/80 hover:bg-surface-2 hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}

/** Testnet notice, admin announcement, wrong network and wallet/session mismatch. */
function Banners() {
  const cfg = useKaziConfig();
  const tc = useTranslations("common");
  const tw = useTranslations("wallet");
  const { isConnected, chainId, address } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { user, mismatch, signIn, signingIn } = useAuth();
  const wrongNetwork = isConnected && chainId !== undefined && chainId !== cfg.chain.id;
  return (
    <div className="text-sm">
      {cfg.settings.announcement ? (
        <div className="bg-ink px-4 py-2 text-center text-bg">{cfg.settings.announcement}</div>
      ) : null}
      {cfg.chain.network !== "mainnet" ? (
        <div className="border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-center text-xs font-medium text-warn">
          {tc("testnetBanner")}{" "}
          <Link href="/get-usdc" className="underline">
            USDC →
          </Link>
        </div>
      ) : null}
      {wrongNetwork ? (
        <div className="flex flex-wrap items-center justify-center gap-3 bg-bad-soft px-4 py-2 text-bad" role="alert">
          <span>{tw("wrongNetwork")}</span>
          <Button size="sm" variant="danger" loading={isPending} onClick={() => switchChain({ chainId: cfg.chain.id })}>
            {tw("switchTo", { name: cfg.chain.name })}
          </Button>
        </div>
      ) : null}
      {mismatch && user && address ? (
        <div className="flex flex-wrap items-center justify-center gap-3 bg-info-soft px-4 py-2 text-info" role="status">
          <span>{tw("mismatch", { signedIn: shortAddress(user.wallet), connected: shortAddress(address) })}</span>
          <Button size="sm" variant="outline" loading={signingIn} onClick={() => void signIn()}>
            {tw("signInAgain")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WalletButton() {
  const t = useTranslations("wallet");
  const nav = useTranslations("nav");
  const { address, isConnected } = useAccount();
  const { user, signIn, signingIn, signOut, error } = useAuth();
  const [menu, setMenu] = useState(false);

  // Signed in (session cookie) but the wallet isn't connected, e.g. after a reload: reconnect.
  if (user && !isConnected) return <ConnectWalletButton compact />;

  if (user) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenu((m) => !m)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink/70 bg-surface px-2.5 font-mono text-xs font-semibold hover:bg-surface-2"
          aria-expanded={menu}
        >
          <span className="size-2 rounded-full bg-ok" aria-hidden />
          {shortAddress(user.wallet)}
        </button>
        {menu ? (
          <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-ink bg-surface p-2 shadow-stamp" onMouseLeave={() => setMenu(false)}>
            <p className="px-2 pt-1 text-xs text-muted">{t("signedInAs")}</p>
            <p className="break-all px-2 pb-2 font-mono text-xs">{user.wallet}</p>
            <Link href="/points" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-2" onClick={() => setMenu(false)}>
              <Sparkles className="size-4" />
              {nav("points")}
            </Link>
            <Link href="/settings/api-keys" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-2" onClick={() => setMenu(false)}>
              <KeyRound className="size-4" />
              {nav("apiKeys")}
            </Link>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2"
              onClick={() => {
                setMenu(false);
                void signOut();
              }}
            >
              <LogOut className="size-4" />
              {t("signOut")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex flex-col items-end">
        <Button size="sm" variant="primary" loading={signingIn} onClick={() => void signIn()} title={t("signInHint")}>
          {signingIn ? t("signingIn") : t("signIn")}
        </Button>
        {error ? <span className="sr-only" role="alert">{error}</span> : null}
      </div>
    );
  }

  return <ConnectWalletButton compact />;
}

export function LocaleSwitch() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const next = locale === "en" ? "sw" : "en";
  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold hover:bg-surface-2"
      aria-label={`${t("language")}: ${next === "sw" ? "Kiswahili" : "English"}`}
      onClick={() => {
        document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      <Languages className="size-4" aria-hidden />
      <span className="font-mono text-xs uppercase">{next}</span>
    </button>
  );
}

export function ThemeToggle() {
  const t = useTranslations("nav");
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    setTheme(document.documentElement.dataset["theme"] === "dark" ? "dark" : "light");
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="grid size-9 place-items-center rounded-lg hover:bg-surface-2"
      aria-label={`${t("theme")}: ${next === "dark" ? t("themeDark") : t("themeLight")}`}
      onClick={() => {
        document.documentElement.dataset["theme"] = next;
        try {
          localStorage.setItem("kazi-theme", next);
        } catch {
          // storage may be blocked; the theme still applies for this visit
        }
        setTheme(next);
      }}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
