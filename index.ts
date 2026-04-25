import "dotenv/config";

import {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    type Message,
    type User,
    type VoiceBasedChannel,
} from "discord.js";
import {
    AudioPlayerStatus,
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
    saveAttachmentToSlot,
    type AudioSlotName,
} from "./audioStorage";
import { logger } from "./logger";

type AudioCommand = "upload" | "delete";

type ParsedCommand = {
    command: AudioCommand;
    isDefaultScope: boolean;
    slotName: AudioSlotName;
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

const PLAYBACK_DEBOUNCE_MS = 30_000;
const recentlyPlayedGuilds = new Set<string>();

const helpMessage = (botUserId: string): string =>
    [
        "Commands:",
        `\`@Dihtator help\` shows this message.`,
        `\`@Dihtator upload join\` uploads your join sound from one attached audio file.`,
        `\`@Dihtator upload leave\` uploads your leave sound from one attached audio file.`,
        `\`@Dihtator upload join @user\` uploads a custom join sound for that user.`,
        `\`@Dihtator upload leave @user\` uploads a custom leave sound for that user.`,
        `\`@Dihtator upload default join\` uploads the default join fallback sound.`,
        `\`@Dihtator upload default leave\` uploads the default leave fallback sound.`,
        `\`@Dihtator delete join\` removes your current join sound.`,
        `\`@Dihtator delete leave\` removes your current leave sound.`,
        `\`@Dihtator delete join @user\` removes that user's custom join sound.`,
        `\`@Dihtator delete leave @user\` removes that user's custom leave sound.`,
        `\`@Dihtator delete default join\` removes the default join fallback sound.`,
        `\`@Dihtator delete default leave\` removes the default leave fallback sound.`
    ].join("\n");

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

    if (command !== "upload" && command !== "delete") {
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
        };
    }

    if (scopeOrSlot !== "join" && scopeOrSlot !== "leave") {
        return null;
    }

    return {
        command,
        isDefaultScope: false,
        slotName: scopeOrSlot,
    };
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

function getPlayableChannel(
    joinedVoiceChannel: boolean,
    oldChannel: VoiceBasedChannel | null,
    newChannel: VoiceBasedChannel | null
): VoiceBasedChannel | null {
    return joinedVoiceChannel ? newChannel : oldChannel;
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
        await message.reply(helpMessage(client.user.id));
        return;
    }

    const parsedCommand = parseCommand(commandText);
    if (!parsedCommand) {
        messageLogger.warn({ commandText }, "Invalid command; sending help message");
        await message.reply(helpMessage(client.user.id));
        return;
    }

    const { command, isDefaultScope, slotName } = parsedCommand;
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
            await message.reply(`Updated ${audioTargetLabel}.`);
            return;
        }

        const removedCount = await deleteSlotAudio(slotName, targetUserId);
        if (removedCount === 0) {
            targetLogger.warn("Delete requested but no matching audio existed");
            await message.reply(`There is no ${audioTargetLabel} to delete.`);
            return;
        }

        targetLogger.info({ removedCount }, "Delete completed successfully");
        await message.reply(`Deleted ${audioTargetLabel}.`);
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

    const joinedVoiceChannel = oldState.channelId === null && newState.channelId !== null;
    const leftVoiceChannel = oldState.channelId !== null && newState.channelId === null;

    if (!joinedVoiceChannel && !leftVoiceChannel) {
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

    const key = member.guild.id;
    if (recentlyPlayedGuilds.has(key)) {
        voiceLogger.debug("Skipped playback because guild is cooling down");
        return;
    }

    recentlyPlayedGuilds.add(key);
    setTimeout(() => {
        recentlyPlayedGuilds.delete(key);
        voiceLogger.debug({ cooldownMs: PLAYBACK_DEBOUNCE_MS }, "Guild playback cooldown expired");
    }, PLAYBACK_DEBOUNCE_MS);

    const channel = getPlayableChannel(joinedVoiceChannel, oldState.channel, newState.channel);
    if (!channel) {
        voiceLogger.warn("Playable voice channel could not be determined");
        return;
    }

    if (leftVoiceChannel) {
        const hasHumanListeners = channel.members.some((guildMember) => !guildMember.user.bot);
        if (!hasHumanListeners) {
            voiceLogger.info(
                { channelId: channel.id },
                "Skipped leave sound because no human listeners remain"
            );
            return;
        }
    }

    const slotName: AudioSlotName = joinedVoiceChannel ? "join" : "leave";
    const audioPath = getAudioPath(slotName, member.id);
    const playbackLogger = voiceLogger.child({
        slotName,
        channelId: channel.id,
    });

    if (!audioPath) {
        playbackLogger.warn("Audio path not found");
        return;
    }

    const botMember = channel.guild.members.me;
    if (!botMember) {
        playbackLogger.error("Bot member is not available in guild");
        return;
    }

    const permissions = channel.permissionsFor(botMember);
    const requiredPermissions = [
        { name: "ViewChannel", value: PermissionFlagsBits.ViewChannel },
        { name: "Connect", value: PermissionFlagsBits.Connect },
        { name: "Speak", value: PermissionFlagsBits.Speak },
    ] as const;
    const missingPermissions = requiredPermissions
        .filter(({ value }) => !permissions?.has(value))
        .map(({ name }) => name);

    if (missingPermissions.length > 0) {
        playbackLogger.warn(
            {
                missingPermissions,
            },
            "Missing voice permissions"
        );
        return;
    }

    playbackLogger.info(
        {
            audioPath,
        },
        "Joining voice channel for playback"
    );

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
        playbackLogger.info("Voice connection is ready");
    } catch (error) {
        playbackLogger.error(error, "Voice connection never became ready");
        connection.destroy();
        return;
    }

    const player = createAudioPlayer();

    player.on("error", (error) => {
        playbackLogger.error(error, "Audio player error");
        connection.destroy();
    });

    const resource = createAudioResource(audioPath, {
        inlineVolume: true,
    });
    resource.volume?.setVolume(0.4);

    const subscribed = connection.subscribe(player);
    if (!subscribed) {
        playbackLogger.warn("Voice connection did not accept player subscription");
    }

    playbackLogger.info({ volume: 0.4 }, "Starting audio playback");
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        playbackLogger.info("Playback finished; leaving VC");
        connection.destroy();
    });
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
