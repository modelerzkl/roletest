//
// index.js
//
require('dotenv').config(); // .envファイルを使うときに必要
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const abi = require('ethereumjs-abi');
const cron = require('node-cron'); // ← node-cron を使う
const { isValidAddress } = require('ethereumjs-util'); // 必要なら利用

// --- zkLink RPC endpoint (必要に応じて変更) ---
const RPC_URL = 'https://rpc.zklink.io/';

// --- ERC-20 関数シグニチャ (balanceOf, decimals, symbol) ---
const BALANCE_OF_SIGNATURE = 'balanceOf(address)';
const DECIMALS_SIGNATURE = 'decimals()';
const SYMBOL_SIGNATURE = 'symbol()';

// --- しきい値とロール名の対応表 ---
const roleThresholds = [
    { roleName: 'zklHolder 🟢', max: 5000 },
    { roleName: 'zkLDolphin 🐬', max: 10000 },
    { roleName: 'zklShark 🦈', max: 50000 },
    { roleName: 'zklWhae 🐋', max: 100000 },
    { roleName: 'zklHumpback 🐳', max: Infinity }
];
// まとめてロール名だけをリスト化（重複削除用）
const roleNames = roleThresholds.map(item => item.roleName);

// --- エンコード用ABI関数 ---
function encodeFunctionCall(signature, ...params) {
    const encoded = abi.simpleEncode(signature, ...params);
    return '0x' + encoded.toString('hex');
}

// --- RPCコール (eth_call) 関数 ---
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

// --- 16進を10進に変換 ---
function decodeHexToDecimal(hexValue) {
    return BigInt(hexValue).toString(10);
}

// --- 16進を文字列に変換 (symbol取得用) ---
function decodeHexToString(hexValue) {
    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    const buf = Buffer.from(hex, 'hex');
    return buf.toString('utf8').replace(/\0/g, '').replace(/[\x00-\x1F\x7F]/g, '');
}

// --- トークン残高・symbol取得 ---
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

        // 人が読みやすい形へ (小数点付き)
        const formattedBalance = (BigInt(hexBalance) / (10n ** BigInt(decimals))).toString();
        return { balance: formattedBalance, symbol: symbol };
    } catch (error) {
        throw new Error(`Token information retrieval error: ${error.message}`);
    }
}

// --- UserID をいろいろな入力 (ユーザー名, メンション, ID) から取得 ---
async function resolveUserId(message, input) {
    // 1) メンション形式 <@1234567890>
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return mentionMatch[1];
    }
    // 2) 数字のみ → 直接IDとみなす
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

    // discriminator がない → ユーザー名のみで検索
    if (!discriminator) {
        const member = members.find(m => m.user.username.toLowerCase() === username.toLowerCase());
        return member ? member.id : null;
    } else {
        // username#1234 形式
        const member = members.find(m =>
            m.user.username.toLowerCase() === username.toLowerCase() &&
            m.user.discriminator === discriminator
        );
        return member ? member.id : null;
    }
}

// --- Discordクライアント初期化 ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// --- SQLite 接続 ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to the database.');
    }
});

// --- DB テーブル作成 (なければ作る) ---
db.run(`
CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL
);
`);

// --- トークンコントラクトアドレス (例) ---
const tokenContractAddress = '0xC967dabf591B1f4B86CFc74996EAD065867aF19E'; // 必要に応じて差し替え

// --- ユーザーの残高を見てロールを付与する共通関数 ---
async function assignRoleByBalance(member, balance, symbol, guild) {
    // 既存の対象ロール(roleNames)を全部外す
    const rolesToRemove = member.roles.cache.filter(r => roleNames.includes(r.name));
    for (const [, roleObj] of rolesToRemove) {
        await member.roles.remove(roleObj);
    }

    // 新規に付与するロール名を決定
    let roleName = roleThresholds.find(th => balance < th.max).roleName;

    // 該当ロールがギルドに存在しない場合は新規作成
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
        role = await guild.roles.create({
            name: roleName,
            color: 'Blue',
            reason: `Automatically created role ${roleName}`
        });
    }

    // ロールを付与
    await member.roles.add(role);

    return { roleName, balance, symbol };
}

// --- Bot起動時 ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // 毎日0:00 (日本時間) に実行したい場合 → timezoneを 'Asia/Tokyo' に
    cron.schedule('0 0 * * *', async () => {
        console.log('[CRON] 毎日 0:00 にトークン残高更新開始');
        await updateAllUserRoles();
        console.log('[CRON] トークン残高更新完了');
    }, {
        scheduled: true,
        timezone: 'Asia/Tokyo' // ← 日本時間にあわせる場合 (UTCなら 'UTC')
    });
});

// --- 毎日実行: DBに登録された全ユーザーの残高を取得しロール更新 ---
async function updateAllUserRoles() {
    try {
        // Botが参加しているサーバーをID指定（YOUR_GUILD_IDを差し替え）
        const guild = client.guilds.cache.get('1332700608951488573');
        if (!guild) {
            console.error('Guildが見つかりません。YOUR_GUILD_IDを正しく設定してください。');
            return;
        }

        // DBから全ユーザー取得
        db.all(`SELECT discord_user_id, wallet_address FROM users`, async (err, rows) => {
            if (err) {
                console.error('Database error:', err.message);
                return;
            }
            if (!rows || rows.length === 0) {
                console.log('登録ユーザーがいません。');
                return;
            }
            // 1人ずつロール更新
            for (const row of rows) {
                const { discord_user_id, wallet_address } = row;
                try {
                    const member = await guild.members.fetch(discord_user_id);
                    const { balance, symbol } = await getTokenBalance(wallet_address, tokenContractAddress);
                    const numericBalance = parseFloat(balance);

                    await assignRoleByBalance(member, numericBalance, symbol, guild);
                    console.log(`[Daily update] ${member.user.tag} -> Balance: ${balance} ${symbol}`);
                } catch (error) {
                    console.error(`updateAllUserRolesエラー: ${error.message}`);
                }
            }
        });
    } catch (error) {
        console.error(`updateAllUserRoles関数のエラー: ${error.message}`);
    }
}

// --- メッセージコマンド監視 ---
client.on('messageCreate', async (message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;
    // コマンド判定
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // 管理者(ロール管理が可能)かチェック
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
        // ウォレットアドレス バリデーション(簡易)
        const isValidWalletAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);
        if (!isValidWalletAddress(walletAddress)) {
            return message.reply('Invalid wallet address.');
        }

        // DB登録 (既存なら上書き)
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

        // DBからウォレットアドレスを取得
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
                // 残高取得
                const { balance, symbol } = await getTokenBalance(walletAddress, tokenContractAddress);
                const numericBalance = parseFloat(balance);

                // ロール付与
                const guild = message.guild;
                const user = await client.users.fetch(discordUserId);
                const member = await guild.members.fetch(user.id);
                const { roleName } = await assignRoleByBalance(member, numericBalance, symbol, guild);

                // メッセージ
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

// --- Discordボット ログイン (トークンは .env で設定) ---
client.login(process.env.DISCORD_TOKEN);

