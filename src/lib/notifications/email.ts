import "server-only";

import { Resend } from "resend";

let cachedClient: Resend | null = null;

function getResendClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY");
  }
  cachedClient = new Resend(apiKey);
  return cachedClient;
}

function getFromAddress() {
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error("Missing RESEND_FROM_EMAIL");
  }
  const fromName = process.env.RESEND_FROM_NAME;
  if (fromName && fromName.trim()) {
    return `${fromName.trim()} <${fromEmail}>`;
  }
  return fromEmail;
}

function formatGreetingName(name?: string | null) {
  const cleaned = (name ?? "").trim();
  if (!cleaned) return "there";
  return cleaned.split(/\s+/)[0] ?? "there";
}

function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "https://app.tuna.so";
}

export async function sendWelcomeEmail(params: { email: string; name?: string | null }) {
  const resend = getResendClient();
  const from = getFromAddress();
  const greeting = formatGreetingName(params.name);
  const appUrl = getAppUrl();

  return resend.emails.send({
    from,
    to: params.email,
    subject: "Welcome to Tuna",
    text: [
      `Hi ${greeting},`,
      "",
      "Welcome to Tuna. Your workspace is ready and we have saved your preferences.",
      "You can start here:",
      appUrl,
      "",
      "If you need help, reply to this email.",
      "",
      "The Tuna team",
    ].join("\n"),
    html: [
      `<p>Hi ${greeting},</p>`,
      "<p>Welcome to Tuna. Your workspace is ready and we have saved your preferences.</p>",
      `<p><a href="${appUrl}">Open the console</a></p>`,
      "<p>If you need help, reply to this email.</p>",
      "<p>The Tuna team</p>",
    ].join(""),
  });
}

export async function sendQueuedTaskStartedEmail(params: {
  email: string;
  name?: string | null;
  chatTitle?: string | null;
}) {
  const resend = getResendClient();
  const from = getFromAddress();
  const greeting = formatGreetingName(params.name);
  const appUrl = getAppUrl();
  const titleLine = params.chatTitle ? `Task: ${params.chatTitle}` : "Your queued task has started.";

  return resend.emails.send({
    from,
    to: params.email,
    subject: "Your queued task is starting",
    text: [
      `Hi ${greeting},`,
      "",
      titleLine,
      "We will notify you when processing completes.",
      "",
      `Open the console: ${appUrl}`,
      "",
      "The Tuna team",
    ].join("\n"),
    html: [
      `<p>Hi ${greeting},</p>`,
      `<p>${titleLine}</p>`,
      "<p>We will notify you when processing completes.</p>",
      `<p><a href="${appUrl}">Open the console</a></p>`,
      "<p>The Tuna team</p>",
    ].join(""),
  });
}
