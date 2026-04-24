if (!process.env.DISCORD_TOKEN) {
    require("dotenv").config();
}

const { Client, GatewayIntentBits } = require("discord.js");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    generateDependencyReport,
} = require("@discordjs/voice");
const {
    MAX_UPLOAD_SIZE_BYTES,
    deleteSlotAudio,
    getAudioPath,
    saveAttachmentToSlot,
} = require("./audioStorage");

console.log(generateDependencyReport());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
    ],
});

const PLAYBACK_DEBOUNCE_MS = 30_000;
const recentlyPlayedGuilds = new Set();
const helpMessage = (botUserId) =>
    [
        "Commands:",
        `\`<@${botUserId}> help\` shows this message.`,
        `\`<@${botUserId}> upload join\` uploads your join sound from one attached audio file.`,
        `\`<@${botUserId}> upload leave\` uploads your leave sound from one attached audio file.`,
        `\`<@${botUserId}> upload join @user\` uploads a custom join sound for that user.`,
        `\`<@${botUserId}> upload leave @user\` uploads a custom leave sound for that user.`,
        `\`<@${botUserId}> upload default join\` uploads the default join fallback sound.`,
        `\`<@${botUserId}> upload default leave\` uploads the default leave fallback sound.`,
        `\`<@${botUserId}> delete join\` removes your current join sound.`,
        `\`<@${botUserId}> delete leave\` removes your current leave sound.`,
        `\`<@${botUserId}> delete join @user\` removes that user's custom join sound.`,
        `\`<@${botUserId}> delete leave @user\` removes that user's custom leave sound.`,
        `\`<@${botUserId}> delete default join\` removes the default join fallback sound.`,
        `\`<@${botUserId}> delete default leave\` removes the default leave fallback sound.`,
        `Supported formats: mp3, wav, ogg, m4a, aac, flac. Max size: ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB.`,
    ].join("\n");

function getMentionedTargetUser(message, botUserId) {
    const targetUsers = message.mentions.users.filter((user) => user.id !== botUserId);

    if (targetUsers.size > 1) {
        throw new Error("Mention only one target user per command.");
    }

    const targetUser = targetUsers.first();
    if (targetUser && targetUser.bot) {
        throw new Error("Custom audio can only be assigned to human users.");
    }

    return targetUser || null;
}

function parseCommand(commandText) {
    const parts = commandText.split(/\s+/).filter(Boolean);
    const [command, scopeOrSlot, slotMaybe] = parts;

    if (!["upload", "delete"].includes(command)) {
        return null;
    }

    if (scopeOrSlot === "default") {
        if (!["join", "leave"].includes(slotMaybe)) {
            return null;
        }

        return {
            command,
            isDefaultScope: true,
            slotName: slotMaybe,
        };
    }

    if (!["join", "leave"].includes(scopeOrSlot)) {
        return null;
    }

    return {
        command,
        isDefaultScope: false,
        slotName: scopeOrSlot,
    };
}

function getAudioTargetLabel(slotName, targetUser, author, isDefaultScope) {
    if (isDefaultScope) {
        return `the default ${slotName} audio`;
    }

    if (targetUser.id === author.id) {
        return `your ${slotName} audio`;
    }

    return `${targetUser.username}'s ${slotName} audio`;
}

client.on("messageCreate", async (message) => {
    if (!client.user || !message.inGuild() || message.author.bot) return;
    if (!message.mentions.has(client.user)) return;

    const commandText = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim()
        .toLowerCase();

    if (!commandText || ["help", "commands"].includes(commandText)) {
        await message.reply(helpMessage(client.user.id));
        return;
    }

    const parsedCommand = parseCommand(commandText);
    if (!parsedCommand) {
        await message.reply(helpMessage(client.user.id));
        return;
    }

    try {
        const mentionedTargetUser = getMentionedTargetUser(message, client.user.id);
        const { command, isDefaultScope, slotName } = parsedCommand;

        if (isDefaultScope && mentionedTargetUser) {
            await message.reply("Do not mention a user when using the default audio commands.");
            return;
        }

        const targetUser = isDefaultScope
            ? null
            : mentionedTargetUser || message.author;
        const targetUserId = targetUser ? targetUser.id : undefined;
        const audioTargetLabel = getAudioTargetLabel(
            slotName,
            targetUser,
            message.author,
            isDefaultScope
        );

        if (command === "upload") {
            const [attachment] = message.attachments.values();
            if (!attachment) {
                await message.reply("Attach one audio file with the upload command.");
                return;
            }

            await saveAttachmentToSlot(slotName, attachment, targetUserId);
            await message.reply(`Updated ${audioTargetLabel}.`);
            return;
        }

        const removedCount = await deleteSlotAudio(slotName, targetUserId);
        if (removedCount === 0) {
            await message.reply(`There is no ${audioTargetLabel} to delete.`);
            return;
        }

        await message.reply(`Deleted ${audioTargetLabel}.`);
    } catch (error) {
        console.error(`Failed to ${command} ${slotName} audio:`, error);
        await message.reply(error.message || `${command} failed.`);
    }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const joinedVoiceChannel = !oldState.channelId && newState.channelId;
    const leftVoiceChannel = oldState.channelId && !newState.channelId;

    if (!joinedVoiceChannel && !leftVoiceChannel) return;

    const key = member.guild.id;
    if (recentlyPlayedGuilds.has(key)) return;

    recentlyPlayedGuilds.add(key);
    setTimeout(() => recentlyPlayedGuilds.delete(key), PLAYBACK_DEBOUNCE_MS);

    const channel = joinedVoiceChannel ? newState.channel : oldState.channel;

    if (leftVoiceChannel) {
        const hasHumanListeners = channel.members.some((m) => !m.user.bot);
        if (!hasHumanListeners) return;
    }

    const slotName = joinedVoiceChannel ? "join" : "leave";
    const audioPath = getAudioPath(slotName, member.id);

    if (!audioPath) {
        console.error(`${slotName} audio not found in assets/`);
        return;
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
    } catch (err) {
        console.error("Voice connection never became ready:", err);
        connection.destroy();
        return;
    }

    const player = createAudioPlayer();

    player.on("error", (err) => {
        console.error("Audio player error:", err);
        connection.destroy();
    });

    const resource = createAudioResource(audioPath, {
        inlineVolume: true,
    });
    resource.volume.setVolume(0.4);

    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio finished or failed; leaving VC");
        connection.destroy();
    });
});

client.login(process.env.DISCORD_TOKEN);
