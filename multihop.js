const fs = require('fs');
const csv = require('csv-parser');
const { ethers } = require('ethers');
require('dotenv').config();

const provider = new ethers.providers.JsonRpcProvider("https://bnb-mainnet.g.alchemy.com/v2/R6vw-Z-lEqm-DmBIPstMZFN7alTQx_qk");

async function loadPools() {
    return new Promise((resolve, reject) => {
        const pools = [];
        fs.createReadStream('./pairs.csv')
            .pipe(csv())
            .on('data', (row) => {
                pools.push({
                    dex: row.DEX,
                    dexAddress: row.DEX_address,
                    tokenA: row.TokenA,
                    tokenB: row.TokenB,
                    tokenAAddress: row.TokenA_address,
                    tokenBAddress: row.TokenB_address,
                    pairAddress: row.PairAddress
                });
            })
            .on('end', () => resolve(pools))
            .on('error', reject);
    });
}

async function getReserves(pairAddress) {
    try {
        const abi = ["function getReserves() external view returns (uint112, uint112, uint32)"];
        const pairContract = new ethers.Contract(pairAddress, abi, provider);
        const [reserve0, reserve1] = await pairContract.getReserves();
        return [reserve0, reserve1];
    } catch (error) {
        console.error(`Error getting reserves for ${pairAddress}:`, error);
        return null;
    }
}

function getAmountOut(amountIn, reserveIn, reserveOut, pool) {
    const feeNumerator = ethers.BigNumber.from(997);
    const feeDenominator = ethers.BigNumber.from(1000);
    const amountInWithFee = amountIn.mul(feeNumerator).div(feeDenominator);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.add(amountInWithFee);
    const amountOut = numerator.div(denominator);

    return amountOut;
}

async function findArbitrageRoutes(startToken, amountIn, maxHops = 6) {
    const pools = await loadPools();
    const routes = [];

    async function exploreRoutes(currentAmount, currentRoute, currentRouteDetails, visitedTokens, hopCount = 0) {
        const routeLog = currentRoute.map((pool, index) => {
            return `${pool.tokenA}(${ethers.utils.formatUnits(currentRouteDetails[index].amountIn, 18)}) -> ${pool.tokenB}(${ethers.utils.formatUnits(currentRouteDetails[index].amountOut, 18)}) [DEX: ${pool.dex}]`;
        }).join(' -> ');

        console.log(`Exploring route (Hop count: ${hopCount}): ${routeLog} -> ${startToken}(${ethers.utils.formatUnits(currentAmount, 18)})`);

        if (hopCount > maxHops) return;

        if (hopCount > 1 && currentRoute.length > 0 && currentRoute[currentRoute.length - 1].tokenB === startToken) {
            const profit = currentAmount.sub(amountIn);
            console.log(`Potential Profit for route: ${ethers.utils.formatUnits(profit, 18)} ${startToken}`);
            routes.push({ route: currentRoute, profit, routeDetails: currentRouteDetails });
            return;
        }

        for (const pool of pools) {
            const lastToken = currentRoute.length > 0 ? currentRoute[currentRoute.length - 1].tokenB : startToken;
            if (pool.tokenA !== lastToken || visitedTokens.has(pool.tokenB)) continue;

            const reserves = await getReserves(pool.pairAddress);
            if (!reserves) continue;

            const amountOut = getAmountOut(currentAmount, reserves[0], reserves[1], pool);
            const newRoute = [...currentRoute, pool];
            const newRouteDetails = [...currentRouteDetails, { pool, amountIn: currentAmount, amountOut, reserves }];
            const newVisitedTokens = new Set(visitedTokens);
            newVisitedTokens.add(pool.tokenA);

            await exploreRoutes(amountOut, newRoute, newRouteDetails, newVisitedTokens, hopCount + 1);
        }
    }

    await exploreRoutes(amountIn, [], [], new Set());
    return routes;
}

async function main() {
    const startToken = 'WBNB'; // Starting and ending token should be the same
    const amountIn = ethers.utils.parseUnits('1000', 18); // 1000 WBNB

    const routes = await findArbitrageRoutes(startToken, amountIn);

    if (routes.length > 0) {
        routes.forEach((routeData, routeIndex) => {
            console.log(`Route ${routeIndex + 1}:`);
            let totalProfit = ethers.BigNumber.from(0); // Initialize total profit for the route
            let routeInput = amountIn;

            routeData.route.forEach((pool, index) => {
                const stepDetails = routeData.routeDetails[index];
                console.log(`  Step ${index + 1}:`);
                console.log(`    Swap: ${pool.tokenA} -> ${pool.tokenB} on ${pool.dex}`);
                console.log(`    Amount In: ${ethers.utils.formatUnits(stepDetails.amountIn, 18)} ${stepDetails.pool.tokenA}`);
                console.log(`    Amount Out: ${ethers.utils.formatUnits(stepDetails.amountOut, 18)} ${stepDetails.pool.tokenB}`);
                console.log(`    Reserves: ${ethers.utils.formatUnits(stepDetails.reserves[0], 18)} ${stepDetails.pool.tokenA}, ${ethers.utils.formatUnits(stepDetails.reserves[1], 18)} ${stepDetails.pool.tokenB}`);
                
                // Add the profit or loss at each step
                totalProfit = totalProfit.add(stepDetails.amountOut).sub(stepDetails.amountIn);
                routeInput = stepDetails.amountOut;
            });

            // Calculate and log the potential profit for the route
            const potentialProfit = totalProfit.sub(amountIn);
            console.log(`  Total Potential Profit for this route: ${ethers.utils.formatUnits(potentialProfit, 18)} ${startToken}`);
            console.log(`  Final Potential Profit/Loss: ${ethers.utils.formatUnits(potentialProfit, 18)} ${startToken}`);
        });
    } else {
        console.log('No arbitrage routes found ending with the start token.');
    }
}

main().catch(error => {
    console.error('Error in main execution:', error);
});
