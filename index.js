require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");

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

console.log(generateDependencyReport());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const recentlyPlayed = new Set();

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

    const fileName = joinedVoiceChannel ? "picolo.mp3" : "leave.mp3";
    const audioPath = path.join(__dirname, fileName);

    if (!fs.existsSync(audioPath)) {
        console.error(`${fileName} not found`);
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
    resource.volume.setVolume(0.05);

    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio finished or failed; leaving VC");
        connection.destroy();
    });
});

client.login(process.env.DISCORD_TOKEN);