require("dotenv").config();

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

const recentlyPlayed = new Set();
const helpMessage = () =>
    [
        "Commands:",
        `\`<@Dihtator> help\` shows this message.`,
        `\`<@Dihtator> upload join\` uploads the default join sound from one attached audio file.`,
        `\`<@Dihtator> upload leave\` uploads the default leave sound from one attached audio file.`,
        `\`<@Dihtator> upload join @user\` uploads a custom join sound for that user.`,
        `\`<@Dihtator> upload leave @user\` uploads a custom leave sound for that user.`,
        `\`<@Dihtator> delete join\` removes the default join sound.`,
        `\`<@Dihtator> delete leave\` removes the default leave sound.`,
        `\`<@Dihtator> delete join @user\` removes that user's custom join sound.`,
        `\`<@Dihtator> delete leave @user\` removes that user's custom leave sound.`
    ].join("\n");

function getTargetUser(message, botUserId) {
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

function getAudioTargetLabel(slotName, targetUser) {
    if (!targetUser) {
        return `the default ${slotName} audio`;
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

    const [command, slotName] = commandText.split(/\s+/);
    if (!["upload", "delete"].includes(command) || !["join", "leave"].includes(slotName)) {
        await message.reply(helpMessage(client.user.id));
        return;
    }

    try {
        const targetUser = getTargetUser(message, client.user.id);
        const targetUserId = targetUser ? targetUser.id : undefined;
        const audioTargetLabel = getAudioTargetLabel(slotName, targetUser);

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

    const eventType = joinedVoiceChannel ? "join" : "leave";
    const key = `${member.guild.id}:${member.id}:${eventType}`;
    if (recentlyPlayed.has(key)) return;

    recentlyPlayed.add(key);
    setTimeout(() => recentlyPlayed.delete(key), 5_000);

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
    resource.volume.setVolume(0.8);

    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio finished or failed; leaving VC");
        connection.destroy();
    });
});

client.login(process.env.DISCORD_TOKEN);