"use server";

import { redirect } from "next/navigation";
import { deleteSession } from "./session";

export async function logoutAction() {
  await deleteSession();
  redirect("/login");
}
