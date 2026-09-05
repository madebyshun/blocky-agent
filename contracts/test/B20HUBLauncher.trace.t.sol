// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test, console } from "forge-std/Test.sol";
import { B20HUBLauncher } from "../B20HUBLauncher.sol";
import { B20HUBHook, PoolKey, Currency } from "../B20HUBHook.sol";
import { BlueBuyBack } from "../BlueBuyBack.sol";

/**
 * B20HUBLauncher.trace.t.sol — reproduce the failing launch() call against
 * a Base mainnet fork with the B20Factory precompile mocked out.
 *
 * The real 0xB20f… precompile lives at the geth layer and is invisible to
 * forge fork tests (call returns "not a contract"). Mocking it lets us
 * step past step 1 (createB20) and observe whether V4 initialize / mint /
 * transfer / renounce succeed downstream.
 *
 * If everything passes here → the mainnet revert is in the createB20 path
 *   (Rust-side ABI decode or policy check), not V4.
 * If it reverts here → the revert selector shows which subcall is broken.
 *
 * Run: forge test --match-test test_traceNewLauncher -vvvv
 */
contract MockB20 {
    // Minimal B20 stand-in that lets the launcher's ERC20 approve /
    // transferFrom / mint calls succeed. Not a real B20 — just enough
    // surface area to validate the launcher's downstream flow.
    string public name;
    string public symbol;
    uint8  public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name; symbol = _symbol; decimals = _decimals;
    }
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
    function grantRole(bytes32, address) external {}
    function renounceRole(bytes32, address) external {}
}

contract MockFactory {
    address public lastDeployed;

    // Must match B20AssetParams in the launcher so `abi.decode(params, (MockParams))`
    // consumes the same single-tuple-with-outer-pointer encoding that
    // `abi.encode(struct)` produces (and matches viem's
    // `parseAbiParameters("(uint8,string,string,address,uint8)")`).
    struct MockParams {
        uint8   version;
        string  name;
        string  symbol;
        address initialAdmin;
        uint8   decimals;
    }

    function createB20(uint8, bytes32 salt, bytes calldata params, bytes[] calldata initCalls)
        external payable returns (address token)
    {
        MockParams memory p = abi.decode(params, (MockParams));
        require(p.version == 1, "MockFactory: bad version");
        token = address(new MockB20(p.name, p.symbol, p.decimals));
        lastDeployed = token;
        // Execute initCalls exactly like a real precompile would.
        for (uint256 i = 0; i < initCalls.length; i++) {
            (bool ok, bytes memory ret) = token.call(initCalls[i]);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
        salt; // silence unused
    }
    function isB20(address a) external view returns (bool) {
        return a == lastDeployed;
    }
}

contract B20HUBLauncherTraceTest is Test {
    address constant B20_FACTORY     = 0xB20f000000000000000000000000000000000000;
    address constant CALLER          = 0xD5C1dFc036F9911348EA8065F73c8123f4013FAB;
    address constant POOL_MANAGER    = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2         = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH9           = 0x4200000000000000000000000000000000000006;
    address constant BLUE            = 0xF895783B2931c919955E18B5e3343e7C7c456bA3;
    address constant TREASURY        = 0xB058A1E305d9C720aa5B1BF42B6f2F6294b03b5F;

    B20HUBLauncher LAUNCHER;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");
        vm.etch(B20_FACTORY, address(new MockFactory()).code);

        // Deploy fresh launcher stack with the updated tick logic.
        BlueBuyBack buyback = new BlueBuyBack(BLUE, WETH9, UNIVERSAL_ROUTER, PERMIT2, TREASURY, 1e15);
        // Deploy hook at any address; V4 permission-bit check will reject unless
        // low 14 bits match, so mock the hook's addr with vm.etch to a bit-valid slot.
        B20HUBHook hookImpl = new B20HUBHook(POOL_MANAGER, POSITION_MANAGER, address(buyback), TREASURY);
        // Copy hook code to a bit-valid address so V4 accepts it during initialize.
        address hookAddr = address(uint160(0x1200)); // low 14 bits = 0x1200
        vm.etch(hookAddr, address(hookImpl).code);
        LAUNCHER = new B20HUBLauncher(B20_FACTORY, POOL_MANAGER, POSITION_MANAGER, PERMIT2, WETH9, hookAddr);
    }

    function test_mockDirect_works() public {
        // Sanity: call the mock directly at B20_FACTORY (after etch).
        (uint8, string, string, address, uint8);
        bytes memory params = abi.encode(uint8(1), "T", "T", address(this), uint8(18));
        bytes[] memory ic = new bytes[](0);
        (bool ok, bytes memory ret) = B20_FACTORY.call(
            abi.encodeWithSignature("createB20(uint8,bytes32,bytes,bytes[])", uint8(0), bytes32(uint256(1)), params, ic)
        );
        console.log("direct createB20 ok:", ok);
        console.log("direct return len:", ret.length);
        if (!ok) console.logBytes(ret);
    }

    function test_traceNewLauncher_realCalldata() public {
        // Same launch() calldata as Metamask on mainnet:
        //   BLUE20/BLUE20/asset/18d/420 supply / sqrtPrice for ~$1000 mcap
        //   / 0.3% fee / creator 0xd5c1dfc… / salt.
        // Build params via struct (launcher v5 removed initialSqrtPriceX96
        // from LaunchParams — opening price is now a contract constant).
        B20HUBLauncher.LaunchParams memory params = B20HUBLauncher.LaunchParams({
            name:        "BLUE20",
            symbol:      "BLUE20",
            variant:     0,
            decimals:    18,
            totalSupply: 420 * 1e18,
            feeTier:     3000,
            creator:     CALLER,
            salt:        bytes32(uint256(1))
        });
        bytes memory data = abi.encodeCall(B20HUBLauncher.launch, (params));

        vm.prank(CALLER);
        (bool ok, bytes memory ret) = address(LAUNCHER).call(data);
        console.log("call ok:", ok);
        console.log("return len:", ret.length);
        console.logBytes(ret);
    }

    /**
     * After launching + faking a swap, claimFees should now succeed under the
     * hook v4 fix (delta == 0 no longer trips beforeRemoveLiquidity). If this
     * reverts with 0x7fe0258e (LpRemovalForbidden) inside 0x90bfb865
     * (Wrap__SubcontextReverted) the fix isn't wired.
     */
    function test_claimFees_afterLaunch() public {
        // Launch first (reuses the traced calldata).
        B20HUBLauncher.LaunchParams memory params = B20HUBLauncher.LaunchParams({
            name:        "BLUE20",
            symbol:      "BLUE20",
            variant:     0,
            decimals:    18,
            totalSupply: 420 * 1e18,
            feeTier:     3000,
            creator:     CALLER,
            salt:        bytes32(uint256(2))
        });
        bytes memory launchData = abi.encodeCall(B20HUBLauncher.launch, (params));
        vm.prank(CALLER);
        (bool launched, bytes memory launchRet) = address(LAUNCHER).call(launchData);
        require(launched, "launch failed");
        (address token, bytes32 poolId, /*uint256 tokenIdA*/, /*uint256 tokenIdB*/) =
            abi.decode(launchRet, (address, bytes32, uint256, uint256));

        // Rebuild the PoolKey the exact way launcher did (WETH is currency0).
        PoolKey memory key = PoolKey({
            currency0:  Currency.wrap(WETH9),
            currency1:  Currency.wrap(token),
            fee:        3000,
            tickSpacing: 60,
            hooks:      address(uint160(0x1200))
        });

        // Call claimFees directly (permissionless). Expect success (no revert).
        (bool ok, bytes memory ret) = address(uint160(0x1200)).call(
            abi.encodeWithSignature("claimFees(bytes32,(address,address,uint24,int24,address))", poolId, key)
        );
        console.log("claimFees ok:", ok);
        console.log("claimFees return len:", ret.length);
        if (!ok) console.logBytes(ret);
    }
}
