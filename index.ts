import "dotenv/config";

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    type Message,
    type User,
    type VoiceBasedChannel,
} from "discord.js";
import {
    type AudioPlayer,
    AudioPlayerStatus,
    StreamType,
    type VoiceConnection,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    generateDependencyReport,
    joinVoiceChannel,
} from "@discordjs/voice";

import {
    MAX_UPLOAD_SIZE_BYTES,
    deleteSlotAudio,
    getAudioPath,
    listSlotAudio,
    saveAttachmentToSlot,
    type AudioSlotName,
} from "./audioStorage";
import ffmpegStatic from "ffmpeg-static";
import { logger } from "./logger";

type AudioCommand = "upload" | "delete" | "list";

type ParsedCommand = {
    command: AudioCommand;
    isDefaultScope: boolean;
    slotName: AudioSlotName;
    args: string[];
};

const botLogger = logger.child({ module: "bot" });

botLogger.info({ dependencyReport: generateDependencyReport() }, "Dependency report");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
    ],
});

type QueuedPlayback = {
    audioPath: string;
    slotName: AudioSlotName;
    userId: string;
    userTag: string;
};

type GuildVoiceSession = {
    guildId: string;
    channelId: string;
    connection: VoiceConnection;
    player: AudioPlayer;
    queue: QueuedPlayback[];
    currentTranscoder: ChildProcessByStdio<null, Readable, Readable> | null;
    isClosing: boolean;
    logger: typeof botLogger;
};

const guildVoiceSessions = new Map<string, GuildVoiceSession>();
const MAX_AUDIO_PLAYBACK_SECONDS = 5;
const USER_AUDIO_RATE_LIMIT_MS = 60_000;
const recentUserAudioPlaybackAt = new Map<string, number>();

if (!ffmpegStatic) {
    throw new Error("ffmpeg-static did not provide an ffmpeg binary path.");
}

const FFMPEG_PATH: string = ffmpegStatic;

const helpMessage = (): string =>
    [
        "Commands:",
        `\`@Dihtator ping\` shows gateway, round-trip, and uptime stats.`,
        `\`@Dihtator help\` shows this message.`,
        `\`@Dihtator upload join\` adds one attached audio file to your join sound pool.`,
        `\`@Dihtator upload leave\` adds one attached audio file to your leave sound pool.`,
        `\`@Dihtator upload join @user\` adds one custom join sound for that user.`,
        `\`@Dihtator upload leave @user\` adds one custom leave sound for that user.`,
        `\`@Dihtator upload default join\` adds one default join fallback sound.`,
        `\`@Dihtator upload default leave\` adds one default leave fallback sound.`,
        `\`@Dihtator list join\` lists your current join sound files.`,
        `\`@Dihtator list leave @user\` lists that user's custom leave sound files.`,
        `\`@Dihtator list default join\` lists the default join fallback sound files.`,
        `\`@Dihtator delete join join-1.mp3\` deletes one of your join sounds by file name.`,
        `\`@Dihtator delete leave @user leave-2.wav\` deletes one custom sound by file name.`,
        `\`@Dihtator delete default join join-3.ogg\` deletes one default fallback sound by file name.`
    ].join("\n");

function formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [
        days > 0 ? `${days}d` : null,
        hours > 0 || days > 0 ? `${hours}h` : null,
        minutes > 0 || hours > 0 || days > 0 ? `${minutes}m` : null,
        `${seconds}s`,
    ].filter(Boolean);

    return parts.join(" ");
}

function getMentionedTargetUser(message: Message, botUserId: string): User | null {
    const targetUsers = message.mentions.users.filter((user) => user.id !== botUserId);

    if (targetUsers.size > 1) {
        throw new Error("Mention only one target user per command.");
    }

    const targetUser = targetUsers.first();
    if (targetUser?.bot) {
        throw new Error("Custom audio can only be assigned to human users.");
    }

    return targetUser ?? null;
}

function parseCommand(commandText: string): ParsedCommand | null {
    const parts = commandText.split(/\s+/).filter(Boolean);
    const [command, scopeOrSlot, slotMaybe] = parts;

    if (command !== "upload" && command !== "delete" && command !== "list") {
        return null;
    }

    if (scopeOrSlot === "default") {
        if (slotMaybe !== "join" && slotMaybe !== "leave") {
            return null;
        }

        return {
            command,
            isDefaultScope: true,
            slotName: slotMaybe,
            args: parts.slice(3),
        };
    }

    if (scopeOrSlot !== "join" && scopeOrSlot !== "leave") {
        return null;
    }

    return {
        command,
        isDefaultScope: false,
        slotName: scopeOrSlot,
        args: parts.slice(2),
    };
}

function getNonMentionArgs(args: readonly string[]): string[] {
    return args.filter((arg) => !/^<@!?\d+>$/.test(arg));
}

function getAudioTargetLabel(
    slotName: AudioSlotName,
    targetUser: User | null,
    author: User,
    isDefaultScope: boolean
): string {
    if (isDefaultScope) {
        return `the default ${slotName} audio`;
    }

    if (!targetUser || targetUser.id === author.id) {
        return `your ${slotName} audio`;
    }

    return `${targetUser.username}'s ${slotName} audio`;
}

function hasHumanMembers(channel: VoiceBasedChannel): boolean {
    return channel.members.some((guildMember) => !guildMember.user.bot);
}

function getCachedVoiceChannel(
    guild: VoiceBasedChannel["guild"],
    channelId: string
): VoiceBasedChannel | null {
    const cachedChannel = guild.channels.cache.get(channelId);
    return cachedChannel?.isVoiceBased() ? cachedChannel : null;
}

function getMissingVoicePermissions(channel: VoiceBasedChannel): string[] {
    const botMember = channel.guild.members.me;
    if (!botMember) {
        return ["GuildMemberUnavailable"];
    }

    const permissions = channel.permissionsFor(botMember);
    const requiredPermissions = [
        { name: "ViewChannel", value: PermissionFlagsBits.ViewChannel },
        { name: "Connect", value: PermissionFlagsBits.Connect },
        { name: "Speak", value: PermissionFlagsBits.Speak },
    ] as const;

    return requiredPermissions
        .filter(({ value }) => !permissions?.has(value))
        .map(({ name }) => name);
}

function getUserPlaybackRateLimitKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
}

function destroyVoiceSession(guildId: string, reason: string): void {
    const session = guildVoiceSessions.get(guildId);
    if (!session) {
        return;
    }

    session.logger.info({ reason }, "Leaving voice channel");
    session.isClosing = true;
    session.queue = [];
    cleanupCurrentTranscoder(session);
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        session.connection.destroy();
    }
    guildVoiceSessions.delete(guildId);
}

function cleanupCurrentTranscoder(session: GuildVoiceSession): void {
    const transcoder = session.currentTranscoder;
    if (!transcoder) {
        return;
    }

    session.currentTranscoder = null;
    if (!transcoder.killed) {
        transcoder.kill("SIGKILL");
    }
}

function drainAudioQueue(session: GuildVoiceSession): void {
    if (session.isClosing || session.player.state.status !== AudioPlayerStatus.Idle) {
        return;
    }

    const nextPlayback = session.queue.shift();
    if (!nextPlayback) {
        return;
    }

    const playbackLogger = session.logger.child({
        slotName: nextPlayback.slotName,
        userId: nextPlayback.userId,
        userTag: nextPlayback.userTag,
        audioPath: nextPlayback.audioPath,
    });

    const transcoder = spawn(
        FFMPEG_PATH,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            nextPlayback.audioPath,
            "-t",
            `${MAX_AUDIO_PLAYBACK_SECONDS}`,
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "pipe:1",
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    session.currentTranscoder = transcoder;

    transcoder.once("error", (error: Error) => {
        playbackLogger.error(error, "ffmpeg failed to start");
        if (session.currentTranscoder === transcoder) {
            session.currentTranscoder = null;
        }
        session.player.stop(true);
    });

    transcoder.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString().trim();
        if (message) {
            playbackLogger.warn({ ffmpegMessage: message }, "ffmpeg stderr");
        }
    });

    transcoder.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (session.currentTranscoder === transcoder) {
            session.currentTranscoder = null;
        }

        playbackLogger.debug({ code, signal }, "ffmpeg transcoder exited");
    });

    const resource = createAudioResource(transcoder.stdout, {
        inlineVolume: true,
        inputType: StreamType.Raw,
    });
    resource.volume?.setVolume(0.4);

    playbackLogger.info({ volume: 0.4, maxSeconds: MAX_AUDIO_PLAYBACK_SECONDS }, "Starting audio playback");
    session.player.play(resource);
}

function enqueueAudioPlayback(session: GuildVoiceSession, playback: QueuedPlayback): void {
    session.queue.push(playback);
    session.logger.debug(
        {
            queueLength: session.queue.length,
            slotName: playback.slotName,
            userId: playback.userId,
        },
        "Queued audio playback"
    );
    drainAudioQueue(session);
}

async function getOrCreateVoiceSession(
    channel: VoiceBasedChannel,
    voiceLogger: typeof botLogger
): Promise<GuildVoiceSession | null> {
    const guildId = channel.guild.id;
    const existingSession = guildVoiceSessions.get(guildId);

    if (existingSession) {
        if (existingSession.channelId === channel.id) {
            return existingSession;
        }

        const existingChannel = getCachedVoiceChannel(channel.guild, existingSession.channelId);
        if (existingChannel && hasHumanMembers(existingChannel)) {
            voiceLogger.info(
                {
                    requestedChannelId: channel.id,
                    connectedChannelId: existingSession.channelId,
                },
                "Skipped joining another voice channel while current channel still has listeners"
            );
            return null;
        }

        destroyVoiceSession(guildId, "connected channel is empty before switching channels");
    }

    const missingPermissions = getMissingVoicePermissions(channel);
    if (missingPermissions.length > 0) {
        voiceLogger.warn(
            {
                channelId: channel.id,
                missingPermissions,
            },
            "Missing voice permissions"
        );
        return null;
    }

    const sessionLogger = botLogger.child({
        module: "voiceSession",
        guildId,
        channelId: channel.id,
    });

    sessionLogger.info("Joining voice channel");
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });
    const player = createAudioPlayer();
    const session: GuildVoiceSession = {
        guildId,
        channelId: channel.id,
        connection,
        player,
        queue: [],
        currentTranscoder: null,
        isClosing: false,
        logger: sessionLogger,
    };

    player.on("error", (error) => {
        sessionLogger.error(error, "Audio player error");
        cleanupCurrentTranscoder(session);
        drainAudioQueue(session);
    });

    player.on(AudioPlayerStatus.Idle, () => {
        sessionLogger.debug({ queueLength: session.queue.length }, "Audio player is idle");
        cleanupCurrentTranscoder(session);
        drainAudioQueue(session);
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        sessionLogger.info("Voice connection destroyed");
        cleanupCurrentTranscoder(session);
        guildVoiceSessions.delete(guildId);
    });

    const subscribed = connection.subscribe(player);
    if (!subscribed) {
        sessionLogger.warn("Voice connection did not accept player subscription");
    }

    guildVoiceSessions.set(guildId, session);

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
        sessionLogger.info("Voice connection is ready");
    } catch (error) {
        sessionLogger.error(error, "Voice connection never became ready");
        cleanupCurrentTranscoder(session);
        guildVoiceSessions.delete(guildId);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
        }
        return null;
    }

    return session;
}

async function enqueueVoiceEventAudio(
    slotName: AudioSlotName,
    channel: VoiceBasedChannel,
    userId: string,
    userTag: string,
    voiceLogger: typeof botLogger,
    shouldCreateSession: boolean
): Promise<void> {
    const rateLimitKey = getUserPlaybackRateLimitKey(channel.guild.id, userId);
    const lastPlaybackAt = recentUserAudioPlaybackAt.get(rateLimitKey);
    const now = Date.now();
    const audioPath = getAudioPath(slotName, userId);
    const playbackLogger = voiceLogger.child({
        slotName,
        channelId: channel.id,
    });

    if (typeof lastPlaybackAt === "number" && now - lastPlaybackAt < USER_AUDIO_RATE_LIMIT_MS) {
        playbackLogger.info(
            {
                rateLimitMs: USER_AUDIO_RATE_LIMIT_MS,
                remainingMs: USER_AUDIO_RATE_LIMIT_MS - (now - lastPlaybackAt),
            },
            "Skipped audio playback because user is rate limited"
        );
        return;
    }

    if (!audioPath) {
        playbackLogger.warn("Audio path not found");
        return;
    }

    let session: GuildVoiceSession | null | undefined = guildVoiceSessions.get(channel.guild.id);
    if (!session || session.channelId !== channel.id) {
        if (!shouldCreateSession) {
            playbackLogger.debug("Skipped playback because bot is not connected to this channel");
            return;
        }

        session = await getOrCreateVoiceSession(channel, playbackLogger);
    }

    if (!session) {
        return;
    }

    enqueueAudioPlayback(session, {
        audioPath,
        slotName,
        userId,
        userTag,
    });
    recentUserAudioPlaybackAt.set(rateLimitKey, now);
}

process.on("unhandledRejection", (reason) => {
    botLogger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
    botLogger.fatal(error, "Uncaught exception");
});

client.on("messageCreate", async (message) => {
    if (!client.user || !message.inGuild() || message.author.bot) {
        return;
    }

    if (!message.mentions.has(client.user)) {
        return;
    }

    const commandText = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim()
        .toLowerCase();

    const messageLogger = botLogger.child({
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        messageId: message.id,
    });

    messageLogger.info({ commandText }, "Mention command received");

    if (!commandText || commandText === "help" || commandText === "commands") {
        messageLogger.info("Sending help message");
        await message.reply(helpMessage());
        return;
    }

    if (commandText === "ping") {
        const pingStartedAt = Date.now();
        const pingLogger = messageLogger.child({ command: "ping" });

        pingLogger.info("Processing ping command");
        const reply = await message.reply("Pinging...");
        const roundTripMs = Date.now() - pingStartedAt;
        const messageLatencyMs = reply.createdTimestamp - message.createdTimestamp;
        const gatewayPingMs = client.ws.ping;
        const uptime = client.uptime ? formatDuration(client.uptime) : "unknown";

        await reply.edit(
            [
                "Pong.",
                `Gateway: ${gatewayPingMs}ms`,
                `Round-trip: ${roundTripMs}ms`,
                `Message latency: ${messageLatencyMs}ms`,
                `Uptime: ${uptime}`,
            ].join("\n")
        );

        pingLogger.info(
            {
                gatewayPingMs,
                roundTripMs,
                messageLatencyMs,
                uptimeMs: client.uptime ?? null,
            },
            "Ping command completed"
        );
        return;
    }

    const parsedCommand = parseCommand(commandText);
    if (!parsedCommand) {
        messageLogger.warn({ commandText }, "Invalid command; sending help message");
        await message.reply(helpMessage());
        return;
    }

    const { command, isDefaultScope, slotName, args } = parsedCommand;
    const commandLogger = messageLogger.child({
        command,
        slotName,
        scope: isDefaultScope ? "default" : "user",
    });

    try {
        const mentionedTargetUser = getMentionedTargetUser(message, client.user.id);

        if (isDefaultScope && mentionedTargetUser) {
            commandLogger.warn(
                { mentionedTargetUserId: mentionedTargetUser.id },
                "Rejected default-scope command with mentioned user"
            );
            await message.reply("Do not mention a user when using the default audio commands.");
            return;
        }

        const targetUser = isDefaultScope ? null : mentionedTargetUser ?? message.author;
        const targetUserId = targetUser?.id;
        const nonMentionArgs = getNonMentionArgs(args);
        const audioTargetLabel = getAudioTargetLabel(
            slotName,
            targetUser,
            message.author,
            isDefaultScope
        );
        const targetLogger = commandLogger.child({
            targetUserId: targetUserId ?? null,
            targetLabel: audioTargetLabel,
        });

        targetLogger.info("Processing audio command");

        if (command === "upload") {
            if (nonMentionArgs.length > 0) {
                await message.reply("Upload commands do not take any extra arguments.");
                return;
            }

            const [attachment] = message.attachments.values();
            if (!attachment) {
                targetLogger.warn("Upload command rejected because no attachment was provided");
                await message.reply("Attach one audio file with the upload command.");
                return;
            }

            await saveAttachmentToSlot(slotName, attachment, targetUserId);
            targetLogger.info(
                {
                    attachmentName: attachment.name,
                    attachmentSize: attachment.size,
                },
                "Upload completed successfully"
            );
            await message.reply(`Added a sound to ${audioTargetLabel}.`);
            return;
        }

        if (command === "list") {
            if (nonMentionArgs.length > 0) {
                await message.reply("List commands do not take any extra arguments.");
                return;
            }

            const audioFiles = listSlotAudio(slotName, targetUserId);
            if (audioFiles.length === 0) {
                await message.reply(`There are no files in ${audioTargetLabel}.`);
                return;
            }

            const fileLines = audioFiles.map((file) => `- ${file.fileName}`);
            await message.reply([`Files in ${audioTargetLabel}:`, ...fileLines].join("\n"));
            return;
        }

        if (nonMentionArgs.length !== 1) {
            await message.reply("Delete commands require exactly one file name. Use the list command first.");
            return;
        }

        const [fileName] = nonMentionArgs;
        const deleted = await deleteSlotAudio(slotName, fileName, targetUserId);
        if (!deleted) {
            targetLogger.warn({ fileName }, "Delete requested but file was not found");
            await message.reply(`Could not find \`${fileName}\` in ${audioTargetLabel}.`);
            return;
        }

        targetLogger.info({ fileName }, "Delete completed successfully");
        await message.reply(`Deleted \`${fileName}\` from ${audioTargetLabel}.`);
    } catch (error) {
        commandLogger.error(error, "Audio command failed");
        const errorMessage = error instanceof Error ? error.message : `${command} failed.`;
        await message.reply(errorMessage);
    }
});

client.once("ready", () => {
    if (!client.user) {
        return;
    }

    botLogger.info({ userTag: client.user.tag }, "Discord client ready");
});

client.on("voiceStateUpdate", async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) {
        return;
    }

    const changedVoiceChannel = oldState.channelId !== newState.channelId;
    const joinedVoiceChannel = changedVoiceChannel && newState.channelId !== null;
    const leftVoiceChannel = changedVoiceChannel && oldState.channelId !== null;

    if (!changedVoiceChannel) {
        return;
    }

    const voiceLogger = botLogger.child({
        event: "voiceStateUpdate",
        guildId: member.guild.id,
        userId: member.id,
        userTag: member.user.tag,
    });

    voiceLogger.info(
        {
            joined: joinedVoiceChannel,
            left: leftVoiceChannel,
            oldChannelId: oldState.channelId,
            newChannelId: newState.channelId,
        },
        "Voice state update received"
    );

    if (leftVoiceChannel && oldState.channel) {
        const session = guildVoiceSessions.get(member.guild.id);
        if (session?.channelId === oldState.channel.id) {
            if (!hasHumanMembers(oldState.channel)) {
                destroyVoiceSession(member.guild.id, "all humans left the connected voice channel");
            } else {
                await enqueueVoiceEventAudio(
                    "leave",
                    oldState.channel,
                    member.id,
                    member.user.tag,
                    voiceLogger,
                    false
                );
            }
        }
    }

    if (joinedVoiceChannel && newState.channel) {
        await enqueueVoiceEventAudio(
            "join",
            newState.channel,
            member.id,
            member.user.tag,
            voiceLogger,
            true
        );
    }
});

const discordToken = process.env.DISCORD_TOKEN;

if (!discordToken) {
    logger.fatal("Missing DISCORD_TOKEN environment variable.");
    throw new Error("Missing DISCORD_TOKEN environment variable.");
}

void client.login(discordToken)
    .then(() => {
        botLogger.info("Discord login succeeded");
    })
    .catch((error) => {
        botLogger.fatal(error, "Discord login failed");
        throw error;
    });
