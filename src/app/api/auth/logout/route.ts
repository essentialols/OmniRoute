import { NextResponse } from "next/server";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);
  // Clear the auth cookie on the response object instead of via next/headers cookies(),
  // which avoids the "cookies was called outside a request scope" failure the indirect
  // cookies() call triggered under the Turbopack production build.
  const response = NextResponse.json({ success: true });
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  logAuditEvent({
    action: "auth.logout.success",
    actor: "admin",
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
  });
  return response;
}
