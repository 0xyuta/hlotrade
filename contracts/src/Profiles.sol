// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Profiles: on-chain usernames and avatar ids for the app
contract Profiles {
    uint8 public constant AVATAR_COUNT = 32;

    mapping(address => string) public nameOf;
    mapping(bytes32 => address) public ownerOfName;
    mapping(address => uint8) public avatarOf;

    event NameSet(address indexed user, string name);
    event AvatarSet(address indexed user, uint8 avatar);

    error BadName();
    error NameTaken();
    error BadAvatar();

    function setName(string calldata name) external {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > 16) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f;
            if (!ok) revert BadName();
        }
        bytes32 key = keccak256(b);
        address owner = ownerOfName[key];
        if (owner != address(0) && owner != msg.sender) revert NameTaken();
        _release(msg.sender);
        ownerOfName[key] = msg.sender;
        nameOf[msg.sender] = name;
        emit NameSet(msg.sender, name);
    }

    function clearName() external {
        _release(msg.sender);
        delete nameOf[msg.sender];
        emit NameSet(msg.sender, "");
    }

    function setAvatar(uint8 id) external {
        if (id >= AVATAR_COUNT) revert BadAvatar();
        avatarOf[msg.sender] = id;
        emit AvatarSet(msg.sender, id);
    }

    function _release(address user) internal {
        bytes memory old = bytes(nameOf[user]);
        if (old.length != 0) delete ownerOfName[keccak256(old)];
    }
}
