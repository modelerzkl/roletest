//
// index.js
//
require('dotenv').config(); // Required when using .env files
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const abi = require('ethereumjs-abi');
const cron = require('node-cron'); // Using node-cron
const { isValidAddress } = require('ethereumjs-util'); // Use if needed

// --- zkLink RPC endpoint (change as needed) ---
const RPC_URL = 'https://rpc.zklink.io/';

// --- ERC-20 function signatures (balanceOf, decimals, symbol) ---
const BALANCE_OF_SIGNATURE = 'balanceOf(address)';
const DECIMALS_SIGNATURE = 'decimals()';
const SYMBOL_SIGNATURE = 'symbol()';

// --- Table mapping thresholds to role names ---
const roleThresholds = [
    { roleName: 'zklHolder', max: 5000 },
    { roleName: 'zkLDolphin 🐬', max: 10000 },
    { roleName: 'zklShark 🦈', max: 50000 },
    { roleName: 'zklWhale 🐋', max: 100000 },
    { roleName: 'zklHumpback 🐳', max: Infinity }
];
// Collect only role names into a list (for deduplication)
const roleNames = roleThresholds.map(item => item.roleName);

// --- ABI function for encoding ---
function encodeFunctionCall(signature, ...params) {
    const encoded = abi.simpleEncode(signature, ...params);
    return '0x' + encoded.toString('hex');
}

// --- RPC call (eth_call) function ---
async function rpcCall(contractAddress, data) {
    const payload = {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
            {
                to: contractAddress,
                data: data
            },
            'latest'
        ],
        id: 1
    };

    try {
        const response = await axios.post(RPC_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.data.error) {
            throw new Error(response.data.error.message);
        }
        return response.data.result;
    } catch (error) {
        throw new Error(`RPC request error: ${error.message}`);
    }
}

// --- Convert hexadecimal to decimal ---
function decodeHexToDecimal(hexValue) {
    return BigInt(hexValue).toString(10);
}

// --- Convert hexadecimal to string (for symbol retrieval) ---
function decodeHexToString(hexValue) {
    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    const buf = Buffer.from(hex, 'hex');
    return buf.toString('utf8').replace(/\0/g, '').replace(/[\x00-\x1F\x7F]/g, '');
}

// --- Retrieve token balance and symbol ---
async function getTokenBalance(userAddr, tokenAddr) {
    try {
        // balanceOf(address)
        const balanceData = encodeFunctionCall(BALANCE_OF_SIGNATURE, userAddr);
        const hexBalance = await rpcCall(tokenAddr, balanceData);
        
        // decimals()
        const decimalsData = encodeFunctionCall(DECIMALS_SIGNATURE);
        const hexDecimals = await rpcCall(tokenAddr, decimalsData);
        
        // symbol()
        const symbolData = encodeFunctionCall(SYMBOL_SIGNATURE);
        const hexSymbol = await rpcCall(tokenAddr, symbolData);

        const balance = decodeHexToDecimal(hexBalance);
        const decimals = decodeHexToDecimal(hexDecimals);
        const symbol = decodeHexToString(hexSymbol);

        // Convert to a human-readable format (with decimals)
        const formattedBalance = (BigInt(hexBalance) / (10n ** BigInt(decimals))).toString();
        return { balance: formattedBalance, symbol: symbol };
    } catch (error) {
        throw new Error(`Token information retrieval error: ${error.message}`);
    }
}

// --- Retrieve UserID from various inputs (username, mention, ID) ---
async function resolveUserId(message, input) {
    // 1) Mention format <@1234567890>
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return mentionMatch[1];
    }
    // 2) Only digits => treat as direct ID
    if (/^\d+$/.test(input)) {
        try {
            await message.guild.members.fetch(input);
            return input;
        } catch {
            return null;
        }
    }
    // 3) username#discriminator or username
    const [username, discriminator] = input.split('#');
    if (!username) {
        return null;
    }
    const members = await message.guild.members.fetch();

    // If there is no discriminator => search by username only
    if (!discriminator) {
        const member = members.find(m => m.user.username.toLowerCase() === username.toLowerCase());
        return member ? member.id : null;
    } else {
        // username#1234 format
        const member = members.find(m =>
            m.user.username.toLowerCase() === username.toLowerCase() &&
            m.user.discriminator === discriminator
        );
        return member ? member.id : null;
    }
}

// --- Initialize Discord client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// --- Connect to SQLite ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to the database.');
    }
});

// --- Create DB table (if it does not exist) ---
db.run(`
CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL
);
`);

// --- Token contract address ---
const tokenContractAddress = '0xC967dabf591B1f4B86CFc74996EAD065867aF19E'; // Replace as needed

// --- Common function to assign roles based on user balance ---
async function assignRoleByBalance(member, balance, symbol, guild) {
    // Remove all existing target roles (roleNames)
    const rolesToRemove = member.roles.cache.filter(r => roleNames.includes(r.name));
    for (const [, roleObj] of rolesToRemove) {
        await member.roles.remove(roleObj);
    }

    // Decide the new role name to be assigned
    let roleName = roleThresholds.find(th => balance < th.max).roleName;

    // If the relevant role does not exist in the guild, create it new
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
        role = await guild.roles.create({
            name: roleName,
            color: 'Blue',
            reason: `Automatically created role ${roleName}`
        });
    }

    // Assign the role
    await member.roles.add(role);

    return { roleName, balance, symbol };
}

// --- When the bot starts ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // If you want to run at 0:00 every day (Japan time), set timezone to 'Asia/Tokyo'
    cron.schedule('0 0 * * *', async () => {
        console.log('[CRON] Starting token balance update at 0:00 every day');
        await updateAllUserRoles();
        console.log('[CRON] Token balance update complete');
    }, {
        scheduled: true,
        timezone: 'UTC' // For matching Japan time (Use 'UTC' for UTC)
    });
});

// --- Run daily: Retrieve the balances of all users in the DB and update roles ---
async function updateAllUserRoles() {
    try {
        // Specify the ID of the server the bot has joined (replace YOUR_GUILD_ID)
        const guild = client.guilds.cache.get('839458691983605832');
        if (!guild) {
            console.error('Guild not found. Please set YOUR_GUILD_ID correctly.');
            return;
        }

        // Retrieve all users from the DB
        db.all(`SELECT discord_user_id, wallet_address FROM users`, async (err, rows) => {
            if (err) {
                console.error('Database error:', err.message);
                return;
            }
            if (!rows || rows.length === 0) {
                console.log('There are no registered users.');
                return;
            }
            // Update roles for each user one by one
            for (const row of rows) {
                const { discord_user_id, wallet_address } = row;
                try {
                    const member = await guild.members.fetch(discord_user_id);
                    const { balance, symbol } = await getTokenBalance(wallet_address, tokenContractAddress);
                    const numericBalance = parseFloat(balance);

                    await assignRoleByBalance(member, numericBalance, symbol, guild);
                    console.log(`[Daily update] ${member.user.tag} -> Balance: ${balance} ${symbol}`);
                } catch (error) {
                    console.error(`updateAllUserRoles error: ${error.message}`);
                }
            }
        });
    } catch (error) {
        console.error(`updateAllUserRoles function error: ${error.message}`);
    }
}

// --- Monitor message commands ---
client.on('messageCreate', async (message) => {
    // Ignore messages from the bot itself
    if (message.author.bot) return;
    // Check for commands
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Check if user is an admin (can manage roles)
    const isModerator = (member) => member.permissions.has(PermissionsBitField.Flags.ManageRoles);

    // 1) !register
    if (command === 'register') {
        if (!isModerator(message.member)) {
            return message.reply('You do not have permission to execute this command.');
        }
        if (args.length < 2) {
            return message.reply('Usage: !register <DiscordUserName#Discriminator or @User or UserID> <WalletAddress>');
        }
        const userInput = args[0].replace(/['"]/g, '');
        const walletAddress = args[1].replace(/['"]/g, '');

        const discordUserId = await resolveUserId(message, userInput);
        if (!discordUserId) {
            return message.reply('The specified user was not found.');
        }
        // Validate wallet address (simple check)
        const isValidWalletAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);
        if (!isValidWalletAddress(walletAddress)) {
            return message.reply('Invalid wallet address.');
        }

        // Register in DB (overwrite if it exists)
        db.run(
            `INSERT OR REPLACE INTO users (discord_user_id, wallet_address) VALUES (?, ?)`,
            [discordUserId, walletAddress],
            function(err) {
                if (err) {
                    console.error(err.message);
                    return message.reply('A database error occurred.');
                }
                message.reply(`Wallet address for <@${discordUserId}> has been registered.`);
            }
        );
    }

    // 2) !checkbalance
    if (command === 'checkbalance') {
        if (!isModerator(message.member)) {
            return message.reply('You do not have permission to execute this command.');
        }
        if (args.length < 1) {
            return message.reply('Usage: !checkbalance <DiscordUserName#Discriminator or @User or UserID>');
        }
        const userInput = args[0].replace(/['"]/g, '');
        const discordUserId = await resolveUserId(message, userInput);
        if (!discordUserId) {
            return message.reply('The specified user was not found.');
        }

        // Retrieve wallet address from DB
        db.get(`SELECT wallet_address FROM users WHERE discord_user_id = ?`, [discordUserId], async (err, row) => {
            if (err) {
                console.error('Database error:', err.message);
                return message.reply('A database error occurred.');
            }
            if (!row) {
                return message.reply('This user has no registered wallet address.');
            }
            const walletAddress = row.wallet_address;

            try {
                // Get balance
                const { balance, symbol } = await getTokenBalance(walletAddress, tokenContractAddress);
                const numericBalance = parseFloat(balance);

                // Assign role
                const guild = message.guild;
                const user = await client.users.fetch(discordUserId);
                const member = await guild.members.fetch(user.id);
                const { roleName } = await assignRoleByBalance(member, numericBalance, symbol, guild);

                // Message
                const sanitizedSymbol = symbol.replace(/[\x00-\x1F\x7F]/g, '');
                message.reply(
                    `${user.tag} has been assigned the role "${roleName}".\n` +
                    `Balance: ${balance} ${sanitizedSymbol}`
                );
            } catch (error) {
                console.error('Error:', error);
                return message.reply('An error occurred while retrieving the token balance.');
            }
        });
    }
});

// --- Discord bot login (token set in .env) ---
client.login(process.env.DISCORD_TOKEN);

