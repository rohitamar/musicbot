import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import type { Attachment } from "discord.js";

import { logger } from "./logger";

const SUPPORTED_EXTENSION_VALUES = [
    ".mp3",
    ".wav",
    ".ogg",
    ".m4a",
    ".aac",
    ".flac",
] as const;

type SupportedExtension = (typeof SUPPORTED_EXTENSION_VALUES)[number];
const storageLogger = logger.child({ module: "audioStorage" });

export const ASSETS_DIR = path.resolve(__dirname, "..", "assets");
export const USER_AUDIO_DIR = path.join(ASSETS_DIR, "users");
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = new Set<SupportedExtension>(SUPPORTED_EXTENSION_VALUES);

const MIME_EXTENSION_MAP: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
};

export const AUDIO_SLOTS = {
    join: {
        aliases: ["join", "picolo"],
    },
    leave: {
        aliases: ["leave"],
    },
} as const;

export type AudioSlotName = keyof typeof AUDIO_SLOTS;

function isSupportedExtension(extension: string): extension is SupportedExtension {
    return SUPPORTED_EXTENSIONS.has(extension as SupportedExtension);
}

export function getAudioPath(slotName: AudioSlotName, userId?: string): string | null {
    const slot = AUDIO_SLOTS[slotName];
    const audioLookupLogger = storageLogger.child({ slotName, userId: userId ?? null });

    if (userId) {
        const userAudioPath = findAudioFile(path.join(USER_AUDIO_DIR, userId), [slotName]);
        if (userAudioPath) {
            audioLookupLogger.debug({ audioPath: userAudioPath }, "Resolved user-specific audio path");
            return userAudioPath;
        }
    }

    const fallbackAudioPath = findAudioFile(ASSETS_DIR, slot.aliases);
    if (fallbackAudioPath) {
        audioLookupLogger.debug({ audioPath: fallbackAudioPath }, "Resolved fallback audio path");
        return fallbackAudioPath;
    }

    audioLookupLogger.warn("No audio path found for slot");
    return null;
}

function findAudioFile(baseDir: string, aliases: readonly string[]): string | null {
    if (!fs.existsSync(baseDir)) {
        return null;
    }

    for (const alias of aliases) {
        for (const extension of SUPPORTED_EXTENSIONS) {
            const candidatePath = path.join(baseDir, `${alias}${extension}`);
            if (fs.existsSync(candidatePath)) {
                return candidatePath;
            }
        }
    }

    return null;
}

function getUploadExtension(attachment: Pick<Attachment, "name" | "url" | "contentType">): string | null {
    const name = attachment.name ?? attachment.url;
    const extension = path.extname(name).toLowerCase();
    const mimeType =
        typeof attachment.contentType === "string" ? attachment.contentType.toLowerCase() : "";

    if (isSupportedExtension(extension)) {
        return extension;
    }

    return MIME_EXTENSION_MAP[mimeType] ?? null;
}

export async function saveAttachmentToSlot(
    slotName: AudioSlotName,
    attachment: Attachment,
    userId?: string
): Promise<string> {
    const slot = AUDIO_SLOTS[slotName];

    if (!attachment) {
        throw new Error("Attach one audio file to upload.");
    }

    if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
        storageLogger.warn(
            { slotName, userId, attachmentSize: attachment.size },
            "Rejected oversized audio upload"
        );
        throw new Error("Audio file is too large. Keep it under 10 MB.");
    }

    const extension = getUploadExtension(attachment);
    if (!extension) {
        storageLogger.warn(
            {
                slotName,
                userId,
                attachmentName: attachment.name,
                contentType: attachment.contentType,
            },
            "Rejected unsupported audio upload"
        );
        throw new Error("Unsupported audio format. Use mp3, wav, ogg, m4a, aac, or flac.");
    }

    const targetDir = userId ? path.join(USER_AUDIO_DIR, userId) : ASSETS_DIR;
    const aliases = userId ? [slotName] : slot.aliases;

    await fsp.mkdir(targetDir, { recursive: true });

    const tempPath = path.join(targetDir, `${slotName}.upload${extension}`);
    const targetPath = path.join(targetDir, `${slotName}${extension}`);

    storageLogger.info(
        {
            slotName,
            userId,
            targetPath,
            attachmentName: attachment.name,
            attachmentSize: attachment.size,
        },
        "Saving uploaded audio"
    );

    try {
        await downloadFile(attachment.url, tempPath);
        await removeSlotFiles(targetDir, aliases);
        await fsp.rename(tempPath, targetPath);
        storageLogger.info({ slotName, userId, targetPath }, "Saved uploaded audio successfully");
    } catch (error) {
        await fsp.rm(tempPath, { force: true });
        storageLogger.error(error, "Failed to save uploaded audio");
        throw error;
    }

    return targetPath;
}

export async function deleteSlotAudio(slotName: AudioSlotName, userId?: string): Promise<number> {
    return deleteAudioForScope(slotName, userId);
}

async function deleteAudioForScope(slotName: AudioSlotName, userId?: string): Promise<number> {
    const slot = AUDIO_SLOTS[slotName];
    const targetDir = userId ? path.join(USER_AUDIO_DIR, userId) : ASSETS_DIR;
    const aliases = userId ? [slotName] : slot.aliases;

    storageLogger.info({ slotName, userId, targetDir }, "Deleting audio for scope");

    await fsp.mkdir(targetDir, { recursive: true });
    const removedCount = await removeSlotFiles(targetDir, aliases);

    if (userId) {
        await removeDirIfEmpty(targetDir);
    }

    storageLogger.info({ slotName, userId, removedCount }, "Finished deleting audio for scope");
    return removedCount;
}

async function removeSlotFiles(targetDir: string, aliases: readonly string[]): Promise<number> {
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    let removedCount = 0;

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const parsedPath = path.parse(entry.name);
        if (!isSupportedExtension(parsedPath.ext.toLowerCase())) {
            continue;
        }

        if (!aliases.includes(parsedPath.name.toLowerCase())) {
            continue;
        }

        await fsp.rm(path.join(targetDir, entry.name), { force: true });
        removedCount += 1;
        storageLogger.debug({ targetDir, fileName: entry.name }, "Removed audio file");
    }

    return removedCount;
}

async function removeDirIfEmpty(targetDir: string): Promise<void> {
    const entries = await fsp.readdir(targetDir);
    if (entries.length === 0) {
        await fsp.rmdir(targetDir);
        storageLogger.debug({ targetDir }, "Removed empty user audio directory");
    }
}

function downloadFile(url: string, destinationPath: string, redirectsRemaining = 5): Promise<void> {
    return new Promise((resolve, reject) => {
        const transport = url.startsWith("https:") ? https : http;
        const request = transport.get(url, (response) => {
            void (async () => {
                try {
                    const statusCode = response.statusCode ?? 500;
                    const redirectUrl = response.headers.location;

                    if (
                        statusCode >= 300 &&
                        statusCode < 400 &&
                        redirectUrl &&
                        redirectsRemaining > 0
                    ) {
                        storageLogger.debug(
                            {
                                url,
                                redirectUrl,
                                redirectsRemaining,
                            },
                            "Following redirect for audio download"
                        );
                        response.resume();
                        const nextUrl = new URL(redirectUrl, url).toString();
                        resolve(
                            await downloadFile(nextUrl, destinationPath, redirectsRemaining - 1)
                        );
                        return;
                    }

                    if (statusCode !== 200) {
                        response.resume();
                        storageLogger.warn({ url, statusCode }, "Audio download failed");
                        reject(new Error(`Download failed with status ${statusCode}.`));
                        return;
                    }

                    storageLogger.debug({ url, destinationPath }, "Downloading audio file");
                    await pipeline(response, fs.createWriteStream(destinationPath));
                    storageLogger.info({ destinationPath }, "Completed audio download");
                    resolve();
                } catch (error) {
                    await fsp.rm(destinationPath, { force: true });
                    storageLogger.error(error, "Failed while streaming audio download");
                    reject(error);
                }
            })();
        });

        request.on("error", (error) => {
            void (async () => {
                await fsp.rm(destinationPath, { force: true });
                storageLogger.error(error, "HTTP error while downloading audio");
                reject(error);
            })();
        });
    });
}
