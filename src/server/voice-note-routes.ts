/**
 * Route handler for voice-note uploads and transcription.
 */

import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, normalize } from "node:path";

import type { RequestAuthContext } from "../auth/request-context";
import type { AgentType } from "../config";
import { deriveNpubSegment } from "../identity/npub-utils";
import type { UploadApiContext } from "./upload-routes.js";
import { maxAttachmentSizeBytes } from "./upload-routes.js";
import { transcribeAudioFile } from "./audio-transcription.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface VoiceNoteUploadApiContext extends UploadApiContext {
  // Intentionally empty; voice notes reuse the existing upload auth/storage model.
}

function parseAgentType(value: unknown, isAgentType: (value: string) => value is AgentType): AgentType | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw || !isAgentType(raw)) {
    return null;
  }
  return raw;
}

function readUploadFile(entry: unknown): Blob & { name?: string; size: number; type?: string } | null {
  if (!entry || typeof (entry as Blob).arrayBuffer !== "function") {
    return null;
  }
  return entry as Blob & { name?: string; size: number; type?: string };
}

function resolveAudioExtension(mimeType: string | undefined): string {
  const normalized = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4")) return ".m4a";
  if (normalized.includes("mpeg")) return ".mp3";
  return ".webm";
}

function isAcceptedVoiceNoteMimeType(mimeType: string | undefined): boolean {
  const normalized = (mimeType ?? "").trim().toLowerCase().split(";")[0] ?? "";
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith("audio/")) {
    return true;
  }
  // Some browsers emit audio-only MediaRecorder blobs in a video container.
  return normalized === "video/webm" || normalized === "video/mp4";
}

type RequestFormData = Awaited<ReturnType<Request["formData"]>>;

async function parseMultipartFormData(request: Request): Promise<RequestFormData | null> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const bodyBlob = await request.blob();
    const bufferedRequest = new Request(request.url, {
      method: request.method,
      headers: { "content-type": contentType },
      body: bodyBlob,
    });
    return await bufferedRequest.formData();
  } catch {
    return null;
  }
}

export async function handleVoiceNoteUploadsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: VoiceNoteUploadApiContext,
): Promise<Response | null> {
  if (url.pathname !== "/api/uploads/voice-notes" || method !== "POST") {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
  if (denied) {
    return denied;
  }

  const form = await parseMultipartFormData(request);
  if (!form) {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const agent = parseAgentType(form.get("agent") as unknown, ctx.isAgentType);
  if (!agent) {
    return Response.json({ error: "Unsupported agent target" }, { status: 400 });
  }

  const audioEntry = readUploadFile(form.get("audio") ?? form.get("file") ?? form.get("voiceNote"));
  if (!audioEntry) {
    return Response.json({ error: "Voice note audio is required" }, { status: 400 });
  }

  if (audioEntry.size === 0) {
    return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
  }

  if (audioEntry.size > maxAttachmentSizeBytes) {
    return Response.json({ error: "Voice note exceeds 25MB limit" }, { status: 413 });
  }

  if (!isAcceptedVoiceNoteMimeType(audioEntry.type ?? undefined)) {
    return Response.json({ error: "Only audio uploads are supported" }, { status: 400 });
  }

  const userNpub = authContext.npub ?? null;
  const voiceSegment = deriveNpubSegment(userNpub);

  let directory: string;
  try {
    directory = await ctx.ensureAttachmentDirectory(agent, userNpub);
  } catch (error) {
    console.error("[voice-notes] failed to ensure directory", error);
    return Response.json({ error: "Failed to prepare voice note storage" }, { status: 500 });
  }

  const filename = `${randomUUID()}${resolveAudioExtension(audioEntry.type ?? undefined)}`;
  const diskPath = join(directory, filename);
  const relativePath = normalize(join(voiceSegment, agent, filename)).replace(/\\/g, "/");
  const publicPath = `/uploads/files/${relativePath}`;

  try {
    const buffer = Buffer.from(await audioEntry.arrayBuffer());
    await writeFile(diskPath, buffer);
  } catch (error) {
    console.error("[voice-notes] failed to persist audio", error);
    return Response.json({ error: "Failed to store voice note" }, { status: 500 });
  }

  let transcript = "";
  try {
    transcript = await transcribeAudioFile({
      audio: Bun.file(diskPath),
      filename,
      mimeType: audioEntry.type ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        error: `Voice note transcription failed: ${message}`,
        agent,
        publicPath,
        relativePath,
      },
      { status: 502 },
    );
  }

  if (!transcript) {
    return Response.json(
      {
        error: "Voice note transcription returned no text",
        agent,
        publicPath,
        relativePath,
      },
      { status: 502 },
    );
  }

  const placeholder = ctx.buildAgentFilePlaceholder(agent, diskPath, publicPath, audioEntry.name ?? "voice note");
  return Response.json(
    {
      agent,
      name: audioEntry.name ?? filename,
      mime: audioEntry.type ?? null,
      publicPath,
      relativePath,
      absolutePath: diskPath,
      placeholder,
      transcript,
      transcriptLength: transcript.length,
    },
    { status: 201 },
  );
}
