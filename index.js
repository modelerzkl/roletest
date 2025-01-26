// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const abi = require('ethereumjs-abi');
const { isValidAddress } = require('ethereumjs-util');

// zkLink RPC endpoint
const RPC_URL = 'https://rpc.zklink.io/';

// ERC-20 balanceOf function signature
const BALANCE_OF_SIGNATURE = 'balanceOf(address)';
const DECIMALS_SIGNATURE = 'decimals()';
const SYMBOL_SIGNATURE = 'symbol()';

/**
 * Creates the data field of a function call using ABI encoding
 * @param {string} signature - Function signature
 * @param  {...any} params - Function parameters
 * @returns {string} - Encoded data field
 */
function encodeFunctionCall(signature, ...params) {
    const encoded = abi.simpleEncode(signature, ...params);
    return '0x' + encoded.toString('hex');
}

/**
 * Sends a JSON-RPC request to call a function
 * @param {string} contractAddress - Contract address
 * @param {string} data - Encoded data field
 * @returns {Promise<string>} - Function return value (hexadecimal)
 */
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
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.data.error) {
            throw new Error(response.data.error.message);
        }

        return response.data.result;
    } catch (error) {
        throw new Error(`RPC request error: ${error.message}`);
    }
}

/**
 * Converts a hexadecimal result to a decimal string
 * @param {string} hexValue - Hexadecimal value
 * @returns {string} - Decimal value
 */
function decodeHexToDecimal(hexValue) {
    return BigInt(hexValue).toString(10);
}

/**
 * Converts a hexadecimal value to an ASCII string
 * @param {string} hexValue - Hexadecimal value
 * @returns {string} - ASCII string
 */
function decodeHexToString(hexValue) {
    // Remove '0x' prefix and pad to byte units
    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    const buf = Buffer.from(hex, 'hex');
    // Remove trailing null bytes and strip control characters
    return buf.toString('utf8').replace(/\0/g, '').replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Retrieves token balance, decimals, and symbol
 * @param {string} userAddr - User's wallet address
 * @param {string} tokenAddr - Token contract address
 * @returns {Promise<{balance: string, symbol: string}>}
 */
async function getTokenBalance(userAddr, tokenAddr) {
    try {
        // balanceOf
        const balanceData = encodeFunctionCall(BALANCE_OF_SIGNATURE, userAddr);
        const hexBalance = await rpcCall(tokenAddr, balanceData);
        const balance = decodeHexToDecimal(hexBalance);

        // decimals
        const decimalsData = encodeFunctionCall(DECIMALS_SIGNATURE);
        const hexDecimals = await rpcCall(tokenAddr, decimalsData);
        const decimals = decodeHexToDecimal(hexDecimals);

        // symbol
        const symbolData = encodeFunctionCall(SYMBOL_SIGNATURE);
        const hexSymbol = await rpcCall(tokenAddr, symbolData);
        const symbol = decodeHexToString(hexSymbol);

        // Convert to a readable format
        const formattedBalance = (BigInt(hexBalance) / (10n ** BigInt(decimals))).toString();

        return {
            balance: formattedBalance,
            symbol: symbol
        };
    } catch (error) {
        throw new Error(`Token information retrieval error: ${error.message}`);
    }
}

/**
 * Function to resolve user ID from input
 * @param {Message} message - Discord message object
 * @param {string} input - User input (username, mention, or ID)
 * @returns {Promise<string|null>} - Resolved user ID or null
 */
async function resolveUserId(message, input) {
    // If in mention format, extract user ID
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return mentionMatch[1];
    }

    // If in user ID format, use directly
    if (/^\d+$/.test(input)) {
        try {
            await message.guild.members.fetch(input);
            return input;
        } catch (error) {
            return null;
        }
    }

    // Search using username and discriminator
    const [username, discriminator] = input.split('#');
    if (!username || !discriminator) {
        // If discriminator is not included
        // Search by username only
        const members = await message.guild.members.fetch();
        const member = members.find(m => m.user.username.toLowerCase() === username.toLowerCase());
        if (member) {
            return member.id;
        }
    } else {
        // Search using username and discriminator
        const members = await message.guild.members.fetch();
        const member = members.find(m => 
            m.user.username.toLowerCase() === username.toLowerCase() && 
            m.user.discriminator === discriminator
        );
        if (member) {
            return member.id;
        }
    }

    // If user is not found
    return null;
}

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent // Added
    ]
});

// Connect to SQLite database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to the database.');
    }
});

// Create table
db.run(`CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL
);`);

// Code to run when the bot is ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// Command processing
client.on('messageCreate', async (message) => {
    // Do not respond to the bot's own messages
    if (message.author.bot) return;

    // Check if the message starts with a command
    if (!message.content.startsWith('!')) return;

    // Split command and arguments
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Function to check admin permissions
    const isModerator = (member) => member.permissions.has(PermissionsBitField.Flags.ManageRoles);

    // Add log
    console.log(`Received command: ${command} from user: ${message.author.tag}`);

    // `!register` command
    if (command === 'register') {
        // Only executable by administrators
        if (!isModerator(message.member)) {
            console.log(`User ${message.author.tag} attempted to run !register without permissions.`);
            return message.reply('You do not have permission to execute this command.');
        }

        if (args.length < 2) {
            console.log('!register command called without sufficient arguments.');
            return message.reply('Usage: !register <DiscordUserName#Discriminator or @User or UserID> <WalletAddress>');
        }

        const userInput = args[0].replace(/['"]/g, '');
        const walletAddress = args[1].replace(/['"]/g, '');

        // Resolve user ID
        const discordUserId = await resolveUserId(message, userInput);
        if (!discordUserId) {
            console.log(`User not found for input: ${userInput}`);
            return message.reply('The specified user was not found. Please use a correct username#Discriminator, mention, or user ID.');
        }

        // Validate wallet address
        const isValidWalletAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);
        if (!isValidWalletAddress(walletAddress)) {
            console.log(`Invalid wallet address provided: ${walletAddress}`);
            return message.reply('Invalid wallet address.');
        }

        // Save to database
        db.run(`INSERT OR REPLACE INTO users (discord_user_id, wallet_address) VALUES (?, ?)`, [discordUserId, walletAddress], function(err) {
            if (err) {
                console.error(err.message);
                return message.reply('A database error occurred.');
            }
            console.log(`Registered user ID: ${discordUserId} with wallet address: ${walletAddress}`);
            return message.reply(`Wallet address for user <@${discordUserId}> has been registered.`);
        });
    }

    // `!checkbalance` command
    if (command === 'checkbalance') {
        // Only executable by administrators
        if (!isModerator(message.member)) {
            console.log(`User ${message.author.tag} attempted to run !checkbalance without permissions.`);
            return message.reply('You do not have permission to execute this command.');
        }

        if (args.length < 1) {
            console.log('!checkbalance command called without sufficient arguments.');
            return message.reply('Usage: !checkbalance <DiscordUserName#Discriminator or @User or UserID>');
        }

        const userInput = args[0].replace(/['"]/g, '');

        // Resolve user ID
        const discordUserId = await resolveUserId(message, userInput);
        if (!discordUserId) {
            console.log(`User not found for input: ${userInput}`);
            return message.reply('The specified user was not found. Please use a correct username#Discriminator, mention, or user ID.');
        }

        console.log(`Fetching balance for Discord User ID: ${discordUserId}`);

        // Retrieve wallet address from database
        db.get(`SELECT wallet_address FROM users WHERE discord_user_id = ?`, [discordUserId], async (err, row) => {
            if (err) {
                console.error('Database error:', err.message);
                return message.reply('A database error occurred.');
            }

            if (!row) {
                console.log(`No wallet address found for Discord User ID: ${discordUserId}`);
                return message.reply('The specified user\'s wallet address was not found.');
            }

            const walletAddress = row.wallet_address;
            console.log(`Retrieved wallet address: ${walletAddress}`);

            try {
                // Set token contract address
                const tokenContractAddress = '0xC967dabf591B1f4B86CFc74996EAD065867aF19E'; // Replace with actual address

                console.log(`Fetching token balance for wallet address: ${walletAddress} and token contract: ${tokenContractAddress}`);

                const { balance, symbol } = await getTokenBalance(walletAddress, tokenContractAddress);

                console.log(`Fetched balance: ${balance} ${symbol}`);

                // Conditional branching
                let roleName = '';
                if (parseFloat(balance) < 5000) {
                    roleName = 'zklHolder 🟢';
                } else if (parseFloat(balance) < 10000) {
                    roleName = 'zkLDolphin 🐬';
                } else if (parseFloat(balance) < 50000) {
                    roleName = 'zklShark 🦈';
                } else if (parseFloat(balance) < 100000) {
                    roleName = 'zklWhae 🐋';
                } else {
                    roleName = 'zklHumpback 🐳';
                }

                console.log(`Determined role name: ${roleName}`);

                // Fetch Discord user
                const user = await client.users.fetch(discordUserId);
                const member = await message.guild.members.fetch(user.id);

                console.log(`Fetched member: ${member.user.tag}`);

                // Get or create role
                let role = message.guild.roles.cache.find(r => r.name === roleName);
                if (!role) {
                    console.log(`Role ${roleName} does not exist. Creating new role.`);
                    role = await message.guild.roles.create({
                        name: roleName,
                        color: 'Blue', // Change as needed
                        reason: `Automatically created role ${roleName}`,
                    });
                    console.log(`Created role: ${roleName}`);
                } else {
                    console.log(`Found existing role: ${roleName}`);
                }

                // Add role
                await member.roles.add(role);
                console.log(`Assigned role ${roleName} to user ${user.tag}`);

                // Sanitize symbol to display balance and symbol correctly
                const sanitizedSymbol = symbol.replace(/[\x00-\x1F\x7F]/g, '');

                message.reply(`${user.tag} has been assigned the role ${roleName}. Balance: ${balance} ${sanitizedSymbol}`);
            } catch (error) {
                console.error('Error during balance check and role assignment:', error);
                return message.reply('An error occurred while retrieving the token balance.');
            }
        });
    }
});

// Bot login
client.login(process.env.DISCORD_TOKEN);

