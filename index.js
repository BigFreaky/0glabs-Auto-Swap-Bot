import "dotenv/config";
import { ethers } from "ethers";
import fs from 'fs'; // Import the file system module
import path from 'path'; // Import path module for reliable file path

// --- Configuration File ---
const CONFIG_FILE_PATH = path.resolve(process.cwd(), 'config.json'); // Expect config.json in the same directory as the script

let config = {
    // Default values, will be overridden by config.json
    USDT_AMOUNT_FOR_SWAP_STR: "50",
    USDT_DECIMALS: 18,
    ETH_AMOUNT_FOR_SWAP_STR: "0.01",
    ETH_DECIMALS: 18,
    BTC_AMOUNT_FOR_SWAP_STR: "0.001",
    BTC_DECIMALS: 18, // Assuming WBTC or similar with 18 decimals
    NUM_SWAPS_PER_PAIR: 10,
    DELAY_SECONDS_MIN: 15,
    DELAY_SECONDS_MAX: 45,
    FEE_TIER: 3000 // Default fee tier (e.g., 0.3% for Uniswap V3)
};

try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
        const configFileContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
        const loadedConfig = JSON.parse(configFileContent);
        config = { ...config, ...loadedConfig }; // Merge default config with loaded config
        console.log("✅ Configuration file loaded successfully.");
    } else {
        console.warn(`⚠️ Configuration file (config.json) not found at ${CONFIG_FILE_PATH}. Using default values. Please create one if you want to customize settings.`);
        // Optionally, create a default config.json if it doesn't exist
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 4), 'utf8');
        console.log(`ℹ️ A default config.json has been created. Please review and customize it.`);
    }
} catch (error) {
    console.error(`🔴 Error loading or parsing config.json: ${error.message}. Using default values.`);
}


// --- Script Constants from Config or Defaults ---
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const ETH_ADDRESS = process.env.ETH_ADDRESS; // Usually WETH or a similar wrapped ETH for DEX swaps
const BTC_ADDRESS = process.env.BTC_ADDRESS; // Usually WBTC or a similar wrapped BTC
const NETWORK_NAME = process.env.NETWORK_NAME || "Unknown Network";

const APPROVAL_GAS_LIMIT = 100000n;
const SWAP_GAS_LIMIT = 250000n;

// Parse amounts from config using their respective decimals
const USDT_AMOUNT_FOR_SWAP = ethers.parseUnits(config.USDT_AMOUNT_FOR_SWAP_STR, config.USDT_DECIMALS);
const ETH_AMOUNT_FOR_SWAP = ethers.parseUnits(config.ETH_AMOUNT_FOR_SWAP_STR, config.ETH_DECIMALS);
const BTC_AMOUNT_FOR_SWAP = ethers.parseUnits(config.BTC_AMOUNT_FOR_SWAP_STR, config.BTC_DECIMALS);
const NUM_SWAPS_PER_PAIR = config.NUM_SWAPS_PER_PAIR;
const DELAY_SECONDS_MIN = config.DELAY_SECONDS_MIN;
const DELAY_SECONDS_MAX = config.DELAY_SECONDS_MAX;
const FEE_TIER = config.FEE_TIER;


// --- Basic Sanity Checks ---
if (!RPC_URL || !PRIVATE_KEY || !ROUTER_ADDRESS || !USDT_ADDRESS || !ETH_ADDRESS || !BTC_ADDRESS) {
    console.error("🔴 Critical Error: Missing one or more required environment variables (RPC_URL, PRIVATE_KEY, ROUTER_ADDRESS, TOKEN_ADDRESSES). Exiting.");
    process.exit(1);
}

// --- Provider and Wallet Setup ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
let nextNonce; // Global nonce manager

// --- ABIs (Simplified from original) ---
const SWAP_ROUTER_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "tokenIn", "type": "address" },
                    { "internalType": "address", "name": "tokenOut", "type": "address" },
                    { "internalType": "uint24", "name": "fee", "type": "uint24" },
                    { "internalType": "address", "name": "recipient", "type": "address" },
                    { "internalType": "uint256", "name": "deadline", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
                    { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
                ],
                "internalType": "struct ISwapRouter.ExactInputSingleParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "exactInputSingle",
        "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
        "stateMutability": "payable",
        "type": "function"
    }
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function decimals() external view returns (uint8)"
];

// --- Helper Functions ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shortHash(hash) {
    if (!hash) return "N/A";
    return `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`;
}

// Modified log function to remove timestamp
async function log(message, isRaw = false) { 
    if (isRaw) {
        console.log(message); // For raw output (logo, section titles), print as is
    } else {
        console.log(message); // Log message directly
    }
}

const LOGO_TEXT = "EARNINGDROP - 0GLABS AUTO SWAP BOT";
const LOGO_BORDER_LENGTH = LOGO_TEXT.length + 4; 

function displayLogo() {
    const hyphenBorder = "-".repeat(LOGO_BORDER_LENGTH);
    const blueColor = "\x1b[34m"; 
    const boldOn = "\x1b[1m";
    const resetAll = "\x1b[0m";  // Resets all attributes (color, bold, etc.)

    log(blueColor + hyphenBorder + resetAll, true);
    log(blueColor + boldOn + `  ${LOGO_TEXT}  ` + resetAll, true);
    log(blueColor + hyphenBorder + resetAll, true);
    log("", true); 
}

// Function to log section titles with new formatting
function logSectionTitle(title) {
    const greenColor = "\x1b[32m"; 
    const resetAll = "\x1b[0m";
    
    const titleWithSpaces = ` ${title} `; // Add spaces around the actual title
    const titleLength = titleWithSpaces.length;
    
    let remainingLengthForHyphens = LOGO_BORDER_LENGTH - titleLength;
    if (remainingLengthForHyphens < 0) remainingLengthForHyphens = 0; // Ensure no negative repeat count

    const hyphensLeftCount = Math.floor(remainingLengthForHyphens / 2);
    const hyphensRightCount = Math.ceil(remainingLengthForHyphens / 2);

    const hyphensLeft = "-".repeat(hyphensLeftCount);
    const hyphensRight = "-".repeat(hyphensRightCount);

    const formattedTitle = hyphensLeft + titleWithSpaces + hyphensRight;

    log("", true); // Extra space above the title
    log(greenColor + formattedTitle + resetAll, true);
    // log("", true); // Space below the title (optional, can be removed if too much)
}


async function initializeNonce() {
    try {
        nextNonce = await wallet.getNonce("pending");
        log(`ℹ️ Initial nonce set to: ${nextNonce}`);
    } catch (error) {
        log(`🔴 Error initializing nonce: ${error.message}`);
        throw error; 
    }
}

async function getCurrentGasPrice() {
    const feeData = await provider.getFeeData();
    return feeData.gasPrice;
}

async function getWalletBalances() {
    try {
        const nativeBalance = await provider.getBalance(wallet.address);
        log(`💰 Native Balance (${NETWORK_NAME}): ${ethers.formatEther(nativeBalance)}`);

        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const usdtBalance = await usdtContract.balanceOf(wallet.address);
        const usdtDecimals = await usdtContract.decimals();
        log(`💰 USDT Balance: ${ethers.formatUnits(usdtBalance, usdtDecimals)}`);

        const ethContract = new ethers.Contract(ETH_ADDRESS, ERC20_ABI, provider);
        const ethBalance = await ethContract.balanceOf(wallet.address);
        const ethDecimals = await ethContract.decimals();
        log(`💰 ETH (Token) Balance: ${ethers.formatUnits(ethBalance, ethDecimals)}`);
        
        const btcContract = new ethers.Contract(BTC_ADDRESS, ERC20_ABI, provider);
        const btcBalance = await btcContract.balanceOf(wallet.address);
        const btcDecimals = await btcContract.decimals();
        log(`💰 BTC (Token) Balance: ${ethers.formatUnits(btcBalance, btcDecimals)}`);

    } catch (error) {
        log(`⚠️ Error fetching wallet balances: ${error.message}`);
    }
}

async function approveTokenIfNeeded(tokenAddress, amountToApprove) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    try {
        const tokenDecimals = await tokenContract.decimals();
        const currentAllowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
        if (currentAllowance >= amountToApprove) {
            log(`✅ Approval for token ${tokenAddress} not needed. Current allowance: ${ethers.formatUnits(currentAllowance, tokenDecimals)}`);
            return true;
        }

        log(`⏳ Approving ${ethers.formatUnits(amountToApprove, tokenDecimals)} of token ${tokenAddress} for router ${ROUTER_ADDRESS}...`);
        const gasPrice = await getCurrentGasPrice();
        const tx = await tokenContract.approve(ROUTER_ADDRESS, amountToApprove, {
            gasLimit: APPROVAL_GAS_LIMIT,
            gasPrice: gasPrice,
            nonce: nextNonce
        });
        log(`🕒 Approval transaction sent: ${shortHash(tx.hash)}. Waiting for confirmation...`);
        await tx.wait();
        log(`✅ Approval successful for token ${tokenAddress}. Tx: ${shortHash(tx.hash)}`);
        nextNonce++;
        return true;
    } catch (error) {
        log(`🔴 Error approving token ${tokenAddress}: ${error.message}`);
        if (error.transactionHash) {
            log(`🔴 Approval Tx Hash: ${error.transactionHash}`);
        }
        if (error.message.toLowerCase().includes("nonce")) {
             log(`ℹ️ Nonce error detected during approval. Attempting to refresh nonce.`);
             await initializeNonce(); 
        }
        return false;
    }
}

async function executeSwap(tokenInAddress, tokenOutAddress, amountIn) {
    if (tokenInAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase() || tokenInAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
        log(`🔴 Swapping native asset directly is not supported by this exactInputSingle ERC20->ERC20 script. Use WETH or equivalent.`);
        return false;
    }

    const swapContract = new ethers.Contract(ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const tokenInContract = new ethers.Contract(tokenInAddress, ERC20_ABI, provider);
    const tokenInDecimals = await tokenInContract.decimals();

    log(`🔄 Attempting to swap ${ethers.formatUnits(amountIn, tokenInDecimals)} of ${tokenInAddress} for ${tokenOutAddress} using fee tier ${FEE_TIER}`);

    try {
        const params = {
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            fee: FEE_TIER, 
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + (60 * 10), 
            amountIn: amountIn,
            amountOutMinimum: 0, 
            sqrtPriceLimitX96: 0n,
        };

        const gasPrice = await getCurrentGasPrice();
        const tx = await swapContract.exactInputSingle(params, {
            gasLimit: SWAP_GAS_LIMIT,
            gasPrice: gasPrice,
            nonce: nextNonce
        });
        log(`🕒 Swap transaction sent: ${shortHash(tx.hash)}. Waiting for confirmation...`);
        const receipt = await tx.wait();
        log(`✅ Swap successful! Tx: ${shortHash(receipt.hash)}. Gas used: ${receipt.gasUsed.toString()}`);
        nextNonce++;
        return true;
    } catch (error) {
        log(`🔴 Error executing swap from ${tokenInAddress} to ${tokenOutAddress}: ${error.message}`);
         if (error.transactionHash) {
            log(`🔴 Swap Tx Hash: ${error.transactionHash}`);
        }
        if (error.message.toLowerCase().includes("nonce")) {
             log(`ℹ️ Nonce error detected during swap. Attempting to refresh nonce.`);
             await initializeNonce(); 
        }
        return false;
    }
}

// --- Main Execution Logic ---
async function main() {
    displayLogo(); 
    log("🚀 Starting Automated Swap Script...");
    log(`Network: ${NETWORK_NAME}`);
    log(`Wallet Address: ${wallet.address}`);
    log(`🔁 Number of swaps per pair: ${NUM_SWAPS_PER_PAIR}`);
    log(`💰 USDT swap amount: ${config.USDT_AMOUNT_FOR_SWAP_STR} (Decimals: ${config.USDT_DECIMALS})`);
    log(`💰 ETH swap amount (when swapping from ETH): ${config.ETH_AMOUNT_FOR_SWAP_STR} (Decimals: ${config.ETH_DECIMALS})`);
    log(`💰 BTC swap amount (when swapping from BTC): ${config.BTC_AMOUNT_FOR_SWAP_STR} (Decimals: ${config.BTC_DECIMALS})`);
    log(`⏱️ Delay between swaps: ${DELAY_SECONDS_MIN}-${DELAY_SECONDS_MAX} seconds`);
    log(`💲 DEX Fee Tier: ${FEE_TIER}`);


    await initializeNonce(); 
    await getWalletBalances();

    // --- 1. USDT to ETH Swaps ---
    logSectionTitle("Starting USDT to ETH Swaps");
    for (let i = 0; i < NUM_SWAPS_PER_PAIR; i++) {
        log(`\n➡️ Swap ${i + 1}/${NUM_SWAPS_PER_PAIR} (USDT -> ETH)`);
        const approved = await approveTokenIfNeeded(USDT_ADDRESS, USDT_AMOUNT_FOR_SWAP);
        if (approved) {
            const swapped = await executeSwap(USDT_ADDRESS, ETH_ADDRESS, USDT_AMOUNT_FOR_SWAP);
            if(swapped) await getWalletBalances();
        } else {
            log(`Skipping swap due to approval failure for USDT.`);
        }
        if (i < NUM_SWAPS_PER_PAIR - 1) {
            const delayValue = Math.floor(Math.random() * (DELAY_SECONDS_MAX - DELAY_SECONDS_MIN + 1)) + DELAY_SECONDS_MIN;
            log(`⏳ Waiting for ${delayValue} seconds before next swap...`);
            await delay(delayValue * 1000);
        }
    }

    // --- 2. USDT to BTC Swaps ---
    logSectionTitle("Starting USDT to BTC Swaps");
    for (let i = 0; i < NUM_SWAPS_PER_PAIR; i++) {
        log(`\n➡️ Swap ${i + 1}/${NUM_SWAPS_PER_PAIR} (USDT -> BTC)`);
        const approved = await approveTokenIfNeeded(USDT_ADDRESS, USDT_AMOUNT_FOR_SWAP);
        if (approved) {
            const swapped = await executeSwap(USDT_ADDRESS, BTC_ADDRESS, USDT_AMOUNT_FOR_SWAP);
            if(swapped) await getWalletBalances();
        } else {
            log(`Skipping swap due to approval failure for USDT.`);
        }
        if (i < NUM_SWAPS_PER_PAIR - 1) {
             const delayValue = Math.floor(Math.random() * (DELAY_SECONDS_MAX - DELAY_SECONDS_MIN + 1)) + DELAY_SECONDS_MIN;
            log(`⏳ Waiting for ${delayValue} seconds before next swap...`);
            await delay(delayValue * 1000);
        }
    }

    // --- 3. BTC to ETH Swaps ---
    logSectionTitle("Starting BTC to ETH Swaps");
    for (let i = 0; i < NUM_SWAPS_PER_PAIR; i++) {
        log(`\n➡️ Swap ${i + 1}/${NUM_SWAPS_PER_PAIR} (BTC -> ETH)`);
        const approved = await approveTokenIfNeeded(BTC_ADDRESS, BTC_AMOUNT_FOR_SWAP);
        if (approved) {
            const swapped = await executeSwap(BTC_ADDRESS, ETH_ADDRESS, BTC_AMOUNT_FOR_SWAP);
            if(swapped) await getWalletBalances();
        } else {
            log(`Skipping swap due to approval failure for BTC.`);
        }
        if (i < NUM_SWAPS_PER_PAIR - 1) {
            const delayValue = Math.floor(Math.random() * (DELAY_SECONDS_MAX - DELAY_SECONDS_MIN + 1)) + DELAY_SECONDS_MIN;
            log(`⏳ Waiting for ${delayValue} seconds before next swap...`);
            await delay(delayValue * 1000);
        }
    }

    log("\n🎉 Automated Swap Script Finished.");
    await getWalletBalances();
}

main().catch(error => {
    console.error("🔴 UNHANDLED CRITICAL ERROR IN MAIN EXECUTION:", error);
    process.exit(1);
});
