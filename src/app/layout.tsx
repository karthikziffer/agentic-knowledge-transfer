import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { getUser } from "@/server/dal";
import { listProjectsWithSkills } from "@/server/projects";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import ToastProvider from "@/components/Toast";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Skill Builder",
  description: "Record a browser workflow with Playwright and turn it into a reusable agentic skill.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getUser();
  const projects = user ? await listProjectsWithSkills(user.id) : [];

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* h-full (not min-h-full) + overflow-hidden caps the shell to the
          viewport so it never scrolls as a whole — the sidebar/header stay
          put and only the content pane below scrolls. */}
      <body className="flex h-full overflow-hidden bg-shell text-ink">
        <ToastProvider>
          {user ? (
            <>
              <Sidebar
                user={{ email: user.email, name: user.name }}
                projects={projects.map((p) => ({
                  id: p.id,
                  name: p.name,
                  skills: p.skills.map((s) => ({ id: s.id, name: s.name })),
                }))}
              />
              <div className="flex flex-1 flex-col overflow-hidden">
                <TopBar
                  projects={projects.map((p) => ({
                    id: p.id,
                    name: p.name,
                    skills: p.skills.map((s) => ({ id: s.id, name: s.name })),
                  }))}
                />
                <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col overflow-hidden">
              <header className="shrink-0 border-b border-edge bg-surface">
                <nav className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-6 text-[13px] font-medium">
                  <Link href="/" className="flex items-center gap-2.5 text-ink">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-white">
                      S
                    </span>
                    <span className="font-semibold tracking-tight">Skill Builder</span>
                  </Link>
                  <div className="flex-1" />
                  <Link href="/login" className="text-ink-muted hover:text-ink">
                    Sign in
                  </Link>
                  <Link href="/register" className="btn btn-primary">
                    Sign up
                  </Link>
                </nav>
              </header>
              <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
            </div>
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
