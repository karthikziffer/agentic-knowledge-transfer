import { notFound } from "next/navigation";
import { verifySession } from "@/server/dal";
import { prisma } from "@/server/db";
import { logoutAction } from "@/server/actions";
import ProfileForm from "@/components/ProfileForm";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await verifySession();
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, bio: true, createdAt: true },
  });
  if (!user) notFound();

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Profile</h1>
        <form action={logoutAction}>
          <button type="submit" className="text-xs font-medium text-error hover:underline">
            Sign out
          </button>
        </form>
      </div>

      <div className="card flex flex-col gap-1 p-4 text-[13px] text-ink-muted">
        <p className="text-ink">{user.email}</p>
        <p className="font-mono text-xs text-ink-faint">
          Member since {new Date(user.createdAt).toLocaleDateString()}
        </p>
      </div>

      <ProfileForm initialName={user.name ?? ""} initialBio={user.bio ?? ""} />
    </div>
  );
}
