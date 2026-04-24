const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const ASSETS_DIR = path.join(__dirname, "assets");
const USER_AUDIO_DIR = path.join(ASSETS_DIR, "users");
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
    ".mp3",
    ".wav",
    ".ogg",
    ".m4a",
    ".aac",
    ".flac",
]);
const MIME_EXTENSION_MAP = {
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

const AUDIO_SLOTS = {
    join: {
        aliases: ["join", "picolo"],
    },
    leave: {
        aliases: ["leave"],
    },
};

function getAudioPath(slotName, userId) {
    const slot = AUDIO_SLOTS[slotName];
    if (!slot) return null;

    if (userId) {
        const userAudioPath = findAudioFile(path.join(USER_AUDIO_DIR, userId), [slotName]);
        if (userAudioPath) {
            return userAudioPath;
        }
    }

    return findAudioFile(ASSETS_DIR, slot.aliases);
}

function findAudioFile(baseDir, aliases) {
    if (!fs.existsSync(baseDir)) return null;

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

function getUploadExtension(attachment) {
    const name = attachment.name || attachment.url;
    const extension = path.extname(name).toLowerCase();
    const mimeType = typeof attachment.contentType === "string"
        ? attachment.contentType.toLowerCase()
        : "";

    if (SUPPORTED_EXTENSIONS.has(extension)) {
        return extension;
    }

    if (MIME_EXTENSION_MAP[mimeType]) {
        return MIME_EXTENSION_MAP[mimeType];
    }

    return null;
}

async function saveAttachmentToSlot(slotName, attachment, userId) {
    const slot = AUDIO_SLOTS[slotName];
    if (!slot) {
        throw new Error("Unknown audio slot.");
    }

    if (!attachment) {
        throw new Error("Attach one audio file to upload.");
    }

    if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
        throw new Error("Audio file is too large. Keep it under 10 MB.");
    }

    const extension = getUploadExtension(attachment);
    if (!extension) {
        throw new Error("Unsupported audio format. Use mp3, wav, ogg, m4a, aac, or flac.");
    }

    const targetDir = userId
        ? path.join(USER_AUDIO_DIR, userId)
        : ASSETS_DIR;
    const aliases = userId ? [slotName] : slot.aliases;

    await fsp.mkdir(targetDir, { recursive: true });

    const tempPath = path.join(targetDir, `${slotName}.upload${extension}`);
    const targetPath = path.join(targetDir, `${slotName}${extension}`);

    try {
        await downloadFile(attachment.url, tempPath);
        await removeSlotFiles(targetDir, aliases);
        await fsp.rename(tempPath, targetPath);
    } catch (error) {
        await fsp.rm(tempPath, { force: true });
        throw error;
    }

    return targetPath;
}

async function deleteSlotAudio(slotName, userId) {
    return deleteAudioForScope(slotName, userId);
}

async function deleteAudioForScope(slotName, userId) {
    const slot = AUDIO_SLOTS[slotName];
    if (!slot) {
        throw new Error("Unknown audio slot.");
    }

    const targetDir = userId
        ? path.join(USER_AUDIO_DIR, userId)
        : ASSETS_DIR;
    const aliases = userId ? [slotName] : slot.aliases;

    await fsp.mkdir(targetDir, { recursive: true });
    const removedCount = await removeSlotFiles(targetDir, aliases);

    if (userId) {
        await removeDirIfEmpty(targetDir);
    }

    return removedCount;
}

async function removeSlotFiles(targetDir, aliases) {
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    let removedCount = 0;

    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile()) return;

        const parsedPath = path.parse(entry.name);
        if (!SUPPORTED_EXTENSIONS.has(parsedPath.ext.toLowerCase())) return;
        if (!aliases.includes(parsedPath.name.toLowerCase())) return;

        await fsp.rm(path.join(targetDir, entry.name), { force: true });
        removedCount += 1;
    }));

    return removedCount;
}

async function removeDirIfEmpty(targetDir) {
    const entries = await fsp.readdir(targetDir);
    if (entries.length === 0) {
        await fsp.rmdir(targetDir);
    }
}

function downloadFile(url, destinationPath, redirectsRemaining = 5) {
    return new Promise((resolve, reject) => {
        const transport = url.startsWith("https:") ? https : http;
        const request = transport.get(url, async (response) => {
            try {
                const statusCode = response.statusCode || 500;
                const redirectUrl = response.headers.location;

                if (
                    statusCode >= 300 &&
                    statusCode < 400 &&
                    redirectUrl &&
                    redirectsRemaining > 0
                ) {
                    response.resume();
                    const nextUrl = new URL(redirectUrl, url).toString();
                    resolve(await downloadFile(nextUrl, destinationPath, redirectsRemaining - 1));
                    return;
                }

                if (statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Download failed with status ${statusCode}.`));
                    return;
                }

                await pipeline(response, fs.createWriteStream(destinationPath));
                resolve();
            } catch (error) {
                await fsp.rm(destinationPath, { force: true });
                reject(error);
            }
        });

        request.on("error", async (error) => {
            await fsp.rm(destinationPath, { force: true });
            reject(error);
        });
    });
}

module.exports = {
    AUDIO_SLOTS,
    MAX_UPLOAD_SIZE_BYTES,
    SUPPORTED_EXTENSIONS,
    deleteSlotAudio,
    getAudioPath,
    saveAttachmentToSlot,
};
