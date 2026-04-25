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
    join: ["join"],
    leave: ["leave"],
} as const;

export type AudioSlotName = keyof typeof AUDIO_SLOTS;
export type StoredAudioFile = {
    fileName: string;
    path: string;
};

function isSupportedExtension(extension: string): extension is SupportedExtension {
    return SUPPORTED_EXTENSIONS.has(extension as SupportedExtension);
}

export function getAudioPath(slotName: AudioSlotName, userId?: string): string | null {
    const audioLookupLogger = storageLogger.child({ slotName, userId: userId ?? null });

    if (userId) {
        const userAudioFiles = listAudioFilesForAliases(path.join(USER_AUDIO_DIR, userId), [slotName]);
        const selectedUserAudioPath = pickRandomAudioPath(userAudioFiles.map((file) => file.path));
        if (selectedUserAudioPath) {
            audioLookupLogger.debug(
                { audioPath: selectedUserAudioPath, candidateCount: userAudioFiles.length },
                "Resolved random user-specific audio path"
            );
            return selectedUserAudioPath;
        }
    }

    const fallbackAudioFiles = listAudioFilesForAliases(ASSETS_DIR, AUDIO_SLOTS[slotName]);
    const selectedFallbackAudioPath = pickRandomAudioPath(fallbackAudioFiles.map((file) => file.path));
    if (selectedFallbackAudioPath) {
        audioLookupLogger.debug(
            { audioPath: selectedFallbackAudioPath, candidateCount: fallbackAudioFiles.length },
            "Resolved random fallback audio path"
        );
        return selectedFallbackAudioPath;
    }

    audioLookupLogger.warn("No audio path found for slot");
    return null;
}

export function listSlotAudio(slotName: AudioSlotName, userId?: string): StoredAudioFile[] {
    const targetDir = userId ? path.join(USER_AUDIO_DIR, userId) : ASSETS_DIR;
    const aliases = userId ? [slotName] : AUDIO_SLOTS[slotName];
    return listAudioFilesForAliases(targetDir, aliases);
}

function listAudioFilesForAliases(baseDir: string, aliases: readonly string[]): StoredAudioFile[] {
    if (!fs.existsSync(baseDir)) {
        return [];
    }

    return fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => createStoredAudioFile(baseDir, entry.name, aliases))
        .filter((file): file is StoredAudioFile => file !== null)
        .sort((left, right) => compareStoredAudioFiles(left.fileName, right.fileName, aliases));
}

function pickRandomAudioPath(audioPaths: readonly string[]): string | null {
    if (audioPaths.length === 0) {
        return null;
    }

    const index = Math.floor(Math.random() * audioPaths.length);
    return audioPaths[index] ?? null;
}

function matchesSlotAlias(fileNameWithoutExtension: string, aliases: readonly string[]): boolean {
    const normalizedName = fileNameWithoutExtension.toLowerCase();
    return aliases.some(
        (alias) =>
            normalizedName === alias.toLowerCase() ||
            normalizedName.startsWith(`${alias.toLowerCase()}-`)
    );
}

function createStoredAudioFile(
    baseDir: string,
    fileName: string,
    aliases: readonly string[]
): StoredAudioFile | null {
    const parsedPath = path.parse(fileName);
    if (!isSupportedExtension(parsedPath.ext.toLowerCase())) {
        return null;
    }

    if (!matchesSlotAlias(parsedPath.name, aliases)) {
        return null;
    }

    return {
        fileName,
        path: path.join(baseDir, fileName),
    };
}

function compareStoredAudioFiles(
    leftFileName: string,
    rightFileName: string,
    aliases: readonly string[]
): number {
    const leftSequence = getFileSequence(leftFileName, aliases);
    const rightSequence = getFileSequence(rightFileName, aliases);

    if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
    }

    if (leftSequence !== null && rightSequence === null) {
        return -1;
    }

    if (leftSequence === null && rightSequence !== null) {
        return 1;
    }

    return leftFileName.localeCompare(rightFileName);
}

function getFileSequence(fileName: string, aliases: readonly string[]): number | null {
    const parsedPath = path.parse(fileName);
    const normalizedName = parsedPath.name.toLowerCase();

    for (const alias of aliases) {
        const normalizedAlias = alias.toLowerCase();
        const match = normalizedName.match(new RegExp(`^${escapeRegExp(normalizedAlias)}-(\\d+)$`));
        if (match) {
            return Number.parseInt(match[1], 10);
        }
    }

    return null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const aliases = userId ? [slotName] : AUDIO_SLOTS[slotName];

    await fsp.mkdir(targetDir, { recursive: true });

    const nextSequence = getNextSequenceNumber(targetDir, aliases);
    const targetFileName = `${slotName}-${nextSequence}${extension}`;
    const tempPath = path.join(targetDir, `${slotName}-${nextSequence}.upload${extension}`);
    const targetPath = path.join(targetDir, targetFileName);

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
        await fsp.rename(tempPath, targetPath);
        storageLogger.info({ slotName, userId, targetPath }, "Saved uploaded audio successfully");
    } catch (error) {
        await fsp.rm(tempPath, { force: true });
        storageLogger.error(error, "Failed to save uploaded audio");
        throw error;
    }

    return targetPath;
}

export async function deleteSlotAudio(
    slotName: AudioSlotName,
    fileName: string,
    userId?: string
): Promise<boolean> {
    const targetDir = userId ? path.join(USER_AUDIO_DIR, userId) : ASSETS_DIR;
    const aliases = userId ? [slotName] : AUDIO_SLOTS[slotName];
    const storedFiles = listAudioFilesForAliases(targetDir, aliases);
    const targetFile = storedFiles.find((file) => file.fileName === fileName);

    storageLogger.info({ slotName, userId, targetDir, fileName }, "Deleting audio file");

    if (!targetFile) {
        return false;
    }

    await fsp.rm(targetFile.path, { force: true });
    storageLogger.debug({ targetDir, fileName }, "Removed audio file");

    if (userId && fs.existsSync(targetDir)) {
        await removeDirIfEmpty(targetDir);
    }

    storageLogger.info({ slotName, userId, fileName }, "Finished deleting audio file");
    return true;
}

function getNextSequenceNumber(targetDir: string, aliases: readonly string[]): number {
    const existingFiles = listAudioFilesForAliases(targetDir, aliases);
    const sequences = existingFiles
        .map((file) => getFileSequence(file.fileName, aliases))
        .filter((sequence): sequence is number => sequence !== null);

    if (sequences.length === 0) {
        return 1;
    }

    return Math.max(...sequences) + 1;
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
