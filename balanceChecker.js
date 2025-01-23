// balanceChecker.js

const axios = require('axios');
const abi = require('ethereumjs-abi');
const { isValidAddress } = require('ethereumjs-util');

// zkLink RPCエンドポイント
const RPC_URL = 'https://rpc.zklink.io/';

// ERC-20 balanceOf関数のシグネチャ
const BALANCE_OF_SIGNATURE = 'balanceOf(address)';
const DECIMALS_SIGNATURE = 'decimals()';
const SYMBOL_SIGNATURE = 'symbol()';

/**
 * ABIエンコードを使用して関数のデータフィールドを作成
 * @param {string} signature - 関数のシグネチャ
 * @param  {...any} params - 関数のパラメータ
 * @returns {string} - エンコードされたデータフィールド
 */
function encodeFunctionCall(signature, ...params) {
    const encoded = abi.simpleEncode(signature, ...params);
    return '0x' + encoded.toString('hex');
}

/**
 * JSON-RPCリクエストを送信して関数を呼び出す
 * @param {string} contractAddress - コントラクトアドレス
 * @param {string} data - エンコードされたデータフィールド
 * @returns {Promise<string>} - 関数の戻り値（16進数）
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
        throw new Error(`RPCリクエストエラー: ${error.message}`);
    }
}

/**
 * 16進数の結果を10進数に変換
 * @param {string} hexValue - 16進数の値
 * @returns {string} - 10進数の値
 */
function decodeHexToDecimal(hexValue) {
    return BigInt(hexValue).toString(10);
}

/**
 * 16進数の値をASCII文字列に変換
 * @param {string} hexValue - 16進数の値
 * @returns {string} - ASCII文字列
 */
function decodeHexToString(hexValue) {
    // Remove '0x' prefix and pad with zeros to make full bytes
    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    const buf = Buffer.from(hex, 'hex');
    // Trim trailing null bytes
    return buf.toString('utf8').replace(/\0/g, '');
}

// コマンドライン引数の取得
const args = process.argv.slice(2);

if (args.length !== 2) {
    console.error('使用方法: node balanceChecker.js <ユーザーアドレス> <トークンコントラクトアドレス>');
    process.exit(1);
}

const [userAddress, tokenContractAddress] = args;

// アドレスの検証
if (!isValidAddress(userAddress)) { // 修正: isValidAddressを使用
    console.error('無効なユーザーアドレスです。');
    process.exit(1);
}

if (!isValidAddress(tokenContractAddress)) { // 修正: isValidAddressを使用
    console.error('無効なトークンコントラクトアドレスです。');
    process.exit(1);
}

// トークン残高、小数点以下の桁数、シンボルの取得と表示
async function displayTokenInfo(userAddr, tokenAddr) {
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

        // 読みやすい形式に変換
        const formattedBalance = (BigInt(hexBalance) / (10n ** BigInt(decimals))).toString();

        console.log(`アドレス ${userAddr} のトークン残高: ${formattedBalance} ${symbol}`);
    } catch (error) {
        console.error(`エラー: ${error.message}`);
    }
}

displayTokenInfo(userAddress, tokenContractAddress);

