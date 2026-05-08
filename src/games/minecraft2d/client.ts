import { GameClient } from "../game";
import { Player } from "../../common";
import { Button } from "../../client/ui-elements";
import {
    MC2D_CHUNK_SIZE,
    MC2D_MATCH_DURATION_SECONDS,
    MC2D_MINING_REACH,
    MC2D_TILE_SIZE_PX
} from "./constants";
import { MC2D_RECIPE_BY_ID, MC2D_RECIPES } from "./recipes";
import { chunkKey, floorDiv, lerp, localTileIndex, sameTile } from "./utils";
import { BlockType, ClientPlayerState, Chunk, GameDelta, GameMessage, GameSnapshot, Inventory, PlaceableBlock, PrivatePlayerState, PublicPlayerState, TilePos } from "./types";
import { LobbyPlayer } from "./types";
import { UserInput } from "../../client/user-input";

const HOTBAR_SLOTS = [
    { key: "dirt", label: "Dirt", tint: "#9b6a3f" },
    { key: "stone", label: "Stone", tint: "#8b96a3" },
    { key: "trunk", label: "Trunk", tint: "#7d4e2e" },
    { key: "wood", label: "Wood", tint: "#a4703f" },
    { key: "iron", label: "Iron", tint: "#c07c4c" },
    { key: "pickaxe_wood", label: "Pickaxe", tint: "#e2e8f0" }
];

const BLOCK_LABELS: Record<string, string> = {
    air: "Air",
    grass: "Grass",
    dirt: "Dirt",
    trunk: "Trunk",
    stone: "Stone",
    iron_ore: "Iron Ore",
    diamond: "Diamond"
};

const MINING_REACH_SQ = MC2D_MINING_REACH * MC2D_MINING_REACH;
const BASE_CONTROLS = [
    "A/D move",
    "W or Space jump",
    "Mouse aim",
    "left click mine",
    "right click place",
    "F attack",
    "Z/X/C select block",
    "1-5 craft"
] as const;

const MATERIAL_LABEL: Record<string, string> = {
    wood: "Wood",
    stone: "Stone",
    trunk: "Trunk",
    iron: "Iron",
    dirt: "Dirt",
    diamond: "Diamond"
};

const formatMaterialName = (material: string): string => MATERIAL_LABEL[material] ?? material;

const RECIPE_REQUIRES: Record<string, readonly (readonly [keyof Inventory, number])[]> = {};
const RECIPE_MATERIALS_TEXT: Record<string, string> = {};

for (let i = 0; i < MC2D_RECIPES.length; i += 1) {
    const recipe = MC2D_RECIPES[i];
    const requires = Object.entries(recipe.requires) as [keyof Inventory, number][];
    RECIPE_REQUIRES[recipe.id] = requires;
    RECIPE_MATERIALS_TEXT[recipe.id] = requires.map(([material, amount]) => `${formatMaterialName(material)} x${amount}`).join("  ");
}

class ClientMessageQueue {
    queue: any[];

    constructor() {
        this.queue = [];
    }

    enqueue(message: any): void {
        this.queue.push(message);
    }

    enqueueMany(messages: any[]): void {
        for (let i = 0; i < messages.length; i += 1) this.queue.push(messages[i]);
    }

    flush(): any[] {
        const out = this.queue;
        this.queue = [];
        return out;
    }
}

class PlayerInterpolator {
    players: Record<string, ClientPlayerState>;

    constructor() {
        this.players = {};
    }

    sync(networkPlayers: Record<string, PublicPlayerState>): void {
        for (const id in networkPlayers) {
            const incoming = networkPlayers[id];
            const existing = this.players[id];
            if (!existing) {
                this.players[id] = { ...incoming, targetX: incoming.x, targetY: incoming.y };
                continue;
            }

            existing.name = incoming.name;
            existing.skin = incoming.skin;
            existing.vx = incoming.vx;
            existing.vy = incoming.vy;
            existing.facing = incoming.facing;
            existing.hp = incoming.hp;
            existing.maxHp = incoming.maxHp;
            existing.dead = incoming.dead;
            existing.targetX = incoming.x;
            existing.targetY = incoming.y;
        }

        for (const id in this.players) if (!networkPlayers[id]) delete this.players[id];
    }

    step(dt: number, myId: string): void {
        const alpha = Math.min(1, dt * 12);
        for (const id in this.players) {
            const player = this.players[id];
            if (player.id === myId) {
                player.x = player.targetX;
                player.y = player.targetY;
                continue;
            }

            player.x = lerp(player.x, player.targetX, alpha);
            player.y = lerp(player.y, player.targetY, alpha);
        }
    }

    getPlayers(): Record<string, ClientPlayerState> {
        return this.players;
    }
}

class MinecraftInputController {
    userInput: UserInput;
    jumpHeld: boolean;
    leftMouseDown: boolean;
    rightClickRequested: boolean;
    lastMiningTarget: TilePos | null;
    pointerTile: TilePos;
    oneShotMessages: any[];
    onKeyDown: (event: KeyboardEvent) => void;
    onKeyUp: (event: KeyboardEvent) => void;
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onContextMenu: (event: MouseEvent) => void;

    constructor(userInput: UserInput) {
        this.userInput = userInput;
        this.jumpHeld = false;
        this.leftMouseDown = false;
        this.rightClickRequested = false;
        this.lastMiningTarget = null;
        this.pointerTile = { x: 0, y: 0 };
        this.oneShotMessages = [];

        this.onKeyDown = (event) => {
            if (event.code === "Space") this.jumpHeld = true;
            if (event.repeat) return;

            if (event.code === "KeyF") {
                this.oneShotMessages.push({ kind: "attack" });
                return;
            }

            this.handleCraftHotkeys(event.code);
            this.handlePlaceableHotkeys(event.code);
        };

        this.onKeyUp = (event) => {
            if (event.code === "Space") this.jumpHeld = false;
        };

        this.onPointerDown = (event) => {
            if (event.button === 0) this.leftMouseDown = true;
            if (event.button === 2) this.rightClickRequested = true;
        };

        this.onPointerUp = (event) => {
            if (event.button === 0) this.leftMouseDown = false;
        };

        this.onContextMenu = (event) => {
            event.preventDefault();
        };

        document.addEventListener("keydown", this.onKeyDown);
        document.addEventListener("keyup", this.onKeyUp);
        this.userInput.canvas.addEventListener("pointerdown", this.onPointerDown);
        this.userInput.canvas.addEventListener("pointerup", this.onPointerUp);
        this.userInput.canvas.addEventListener("contextmenu", this.onContextMenu);
    }

    getPointerTile(): TilePos {
        return this.pointerTile;
    }

    dispose(): void {
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("keyup", this.onKeyUp);
        this.userInput.canvas.removeEventListener("pointerdown", this.onPointerDown);
        this.userInput.canvas.removeEventListener("pointerup", this.onPointerUp);
        this.userInput.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }

    handleCraftHotkeys(code: string): void {
        const craftMap: Record<string, string> = {
            Digit1: "craft_pickaxe_wood",
            Digit2: "craft_sword_stone",
            Digit3: "craft_sword_iron",
            Digit4: "upgrade_pickaxe_stone",
            Digit5: "upgrade_pickaxe_iron"
        };

        const recipeId = craftMap[code];
        if (!recipeId) return;

        this.oneShotMessages.push({
            kind: "craft",
            recipeId
        });
    }

    handlePlaceableHotkeys(code: string): void {
        if (code === "KeyZ") {
            this.oneShotMessages.push({
                kind: "select_placeable",
                block: "dirt"
            });
            return;
        }

        if (code === "KeyX") {
            this.oneShotMessages.push({
                kind: "select_placeable",
                block: "stone"
            });
            return;
        }

        if (code === "KeyC") {
            this.oneShotMessages.push({
                kind: "select_placeable",
                block: "trunk"
            });
        }
    }
}

class PixelRenderer {
    private skyCtx: CanvasRenderingContext2D | null = null;
    private skyH = 0;
    private sky: CanvasGradient | null = null;

    drawWorld(
        ctx: CanvasRenderingContext2D,
        screenW: number,
        screenH: number,
        chunks: Record<string, Chunk>,
        players: Record<string, ClientPlayerState>,
        camera: { x: number; y: number; zoom: number },
        myId: string,
        miningTarget: TilePos | null,
        miningTargetReachable: boolean,
        diamondPos: TilePos | null
    ): void {
        this.drawBackground(ctx, screenW, screenH);
        ctx.save();
        ctx.translate(screenW / 2, screenH / 2);
        ctx.scale(camera.zoom * MC2D_TILE_SIZE_PX, -camera.zoom * MC2D_TILE_SIZE_PX);
        ctx.translate(-camera.x, -camera.y);
        this.drawTiles(ctx, chunks);
        this.drawPlayers(ctx, players, myId);
        this.drawMiningTarget(ctx, miningTarget, miningTargetReachable);
        this.drawDiamondPing(ctx, diamondPos);
        ctx.restore();
    }

    drawBackground(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
        if (!this.sky || this.skyH !== screenH || this.skyCtx !== ctx) {
            const sky = ctx.createLinearGradient(0, 0, 0, screenH);
            sky.addColorStop(0, "#77bde0");
            sky.addColorStop(0.52, "#4d8db3");
            sky.addColorStop(1, "#16202b");
            this.sky = sky;
            this.skyH = screenH;
            this.skyCtx = ctx;
        }

        ctx.fillStyle = this.sky;
        ctx.fillRect(0, 0, screenW, screenH);
    }

    drawTiles(ctx: CanvasRenderingContext2D, chunks: Record<string, Chunk>): void {
        for (const chunkId in chunks) {
            const chunk = chunks[chunkId];
            const tiles = chunk.tiles;
            const baseX = chunk.chunkX * MC2D_CHUNK_SIZE;
            const baseY = chunk.chunkY * MC2D_CHUNK_SIZE;

            for (let index = 0; index < tiles.length; index += 1) {
                const block = tiles[index];
                if (block === "air") continue;
                const localX = index % MC2D_CHUNK_SIZE;
                const localY = Math.floor(index / MC2D_CHUNK_SIZE);
                const tileX = baseX + localX;
                const tileY = baseY + localY;
                ctx.fillStyle = blockColor(block);
                ctx.fillRect(tileX, tileY, 1, 1);
                ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
                ctx.fillRect(tileX, tileY, 1, 0.08);
            }
        }
    }

    drawPlayers(ctx: CanvasRenderingContext2D, players: Record<string, ClientPlayerState>, myId: string): void {
        for (const id in players) {
            const player = players[id];
            const bodyW = 0.68;
            const bodyH = 1.8;
            ctx.globalAlpha = player.dead ? 0.4 : 1;
            ctx.fillStyle = player.skin;
            ctx.fillRect(player.x - bodyW / 2, player.y - bodyH / 2, bodyW, bodyH);
            ctx.fillStyle = "rgba(18, 18, 18, 0.55)";
            ctx.fillRect(player.x - 0.5, player.y + 1.02, 1, 0.18);
            const hpRatio = Math.max(0, Math.min(1, player.hp / player.maxHp));
            ctx.fillStyle = "#22c55e";
            ctx.fillRect(player.x - 0.5, player.y + 1.02, hpRatio, 0.18);
            ctx.globalAlpha = 1;
        }
    }

    drawMiningTarget(ctx: CanvasRenderingContext2D, target: TilePos | null, reachable: boolean): void {
        if (!target) return;
        ctx.lineWidth = 2 / (MC2D_TILE_SIZE_PX * 0.6);
        ctx.strokeStyle = reachable ? "#f8fafc" : "#ef4444";
        ctx.strokeRect(target.x, target.y, 1, 1);
    }

    drawDiamondPing(ctx: CanvasRenderingContext2D, diamondPos: TilePos | null): void {
        if (!diamondPos) return;
        ctx.fillStyle = "rgba(41, 184, 197, 0.45)";
        ctx.fillRect(diamondPos.x, diamondPos.y, 1, 1);
    }
}

export class MinecraftDiamondRushClient extends GameClient {
    networkQueue: ClientMessageQueue;
    controller: MinecraftInputController;
    interpolator: PlayerInterpolator;
    renderer: PixelRenderer;
    chunks: Record<string, Chunk>;
    lobbyPlayers: Record<string, LobbyPlayer>;
    privateState: PrivatePlayerState | null;
    summary: GameSnapshot["summary"] | GameDelta["summary"] | null;
    matchEndsAtMs: number;
    diamondPos: TilePos | null;
    camera: { x: number; y: number; zoom: number };
    wantsExit: boolean;
    disposed: boolean;
    exitButton: Button;

    constructor(userInput: UserInput, myId: string) {
        super(userInput, myId);
        this.networkQueue = new ClientMessageQueue();
        this.controller = new MinecraftInputController(userInput);
        this.interpolator = new PlayerInterpolator();
        this.renderer = new PixelRenderer();
        this.chunks = {};
        this.lobbyPlayers = {};
        this.privateState = null;
        this.summary = null;
        this.matchEndsAtMs = Date.now() + MC2D_MATCH_DURATION_SECONDS * 1000;
        this.diamondPos = null;
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.wantsExit = false;
        this.disposed = false;
        this.exitButton = new Button("Torna alla lobby", this.userInput, () => {
            this.wantsExit = true;
        });
        this.exitButton.setColors({ main: "#2563eb" });
    }

    init(players: Record<string, Player>): void {
        Object.assign(this.lobbyPlayers, players);
    }

    draw(ctx: CanvasRenderingContext2D, dt: number): void {
        if (!this.privateState) {
            this.drawWaitingScreen(ctx);
            return;
        }

        const players = this.interpolator.getPlayers();
        const me = players[this.myId];

        if (!this.summary) {
            const frameMessages = this.collectInputMessages();
            this.networkQueue.enqueueMany(frameMessages);
            this.interpolator.step(dt, this.myId);

            if (me) {
                const follow = Math.min(1, dt * 10);
                this.camera.x = this.camera.x + (me.x - this.camera.x) * follow;
                this.camera.y = this.camera.y + (me.y - this.camera.y) * follow;
            }

            this.updatePointerState(me);
            this.networkQueue.enqueueMany(this.collectPointerMessages());
        }

        this.renderer.drawWorld(
            ctx,
            this.userInput.screenW,
            this.userInput.screenH,
            this.chunks,
            players,
            this.camera,
            this.myId,
            this.controller.getPointerTile(),
            this.pointerReachable,
            this.diamondPos
        );

        this.drawPlayerLabels(ctx, players);
        this.drawTopInfo(ctx, me);
        this.drawRecipeSidebar(ctx);
        this.drawHotbar(ctx);
        this.drawPickaxeSlot(ctx);
        this.drawHoverBlockInfo(ctx, me);

        if (this.summary) {
            this.drawSummaryOverlay(ctx);
        }
    }

    handleMessage(message: GameMessage): void {
        if (message.kind === "snapshot") {
            this.applySnapshot(message);
        } else if (message.kind === "delta") {
            this.applyDelta(message);
        }
    }

    flushMessages(): any[] {
        return this.networkQueue.flush();
    }

    isFinished(): boolean {
        return this.wantsExit;
    }

    collectInputMessages(): any[] {
        const left = this.userInput.moveDirectionX < -0.1;
        const right = this.userInput.moveDirectionX > 0.1;
        const jump = this.controller.jumpHeld || this.userInput.moveDirectionY < -0.1;
        const frameMessages: any[] = [{
            kind: "input",
            left,
            right,
            jump
        }];

        const oneShots = this.controller.oneShotMessages;
        for (let i = 0; i < oneShots.length; i += 1) frameMessages.push(oneShots[i]);
        oneShots.length = 0;
        return frameMessages;
    }

    collectPointerMessages(): any[] {
        const frameMessages: any[] = [];
        const pointerTile = this.controller.pointerTile;

        if (this.controller.leftMouseDown && pointerTile && this.pointerReachable) {
            if (!this.controller.lastMiningTarget || !sameTile(this.controller.lastMiningTarget, pointerTile)) {
                frameMessages.push({
                    kind: "mine_start",
                    target: { x: pointerTile.x, y: pointerTile.y }
                });
                const existing = this.controller.lastMiningTarget;
                if (existing) {
                    existing.x = pointerTile.x;
                    existing.y = pointerTile.y;
                } else {
                    this.controller.lastMiningTarget = { x: pointerTile.x, y: pointerTile.y };
                }
            }
        } else if (this.controller.lastMiningTarget) {
            frameMessages.push({ kind: "mine_stop" });
            this.controller.lastMiningTarget = null;
        }

        if (this.controller.rightClickRequested && pointerTile && this.privateState) {
            frameMessages.push({
                kind: "place_block",
                target: { x: pointerTile.x, y: pointerTile.y },
                block: this.privateState.selectedPlaceable
            });
        }

        this.controller.rightClickRequested = false;
        return frameMessages;
    }

    updatePointerState(me: ClientPlayerState | undefined): void {
        this.screenToTileInto(this.userInput.mouseX, this.userInput.mouseY, this.controller.pointerTile);

        const pointerTile = this.controller.pointerTile;
        this.pointerBlock = this.getBlockAt(pointerTile);
        if (me) {
            const dx = me.x - (pointerTile.x + 0.5);
            const dy = me.y - (pointerTile.y + 0.5);
            this.pointerReachable = dx * dx + dy * dy <= MINING_REACH_SQ;
        } else {
            this.pointerReachable = false;
        }
    }

    canCraftRecipe(recipeId: string): boolean {
        if (!this.privateState) return false;
        if (!MC2D_RECIPE_BY_ID[recipeId]) return false;
        const requires = RECIPE_REQUIRES[recipeId];
        if (!requires) return false;
        const inv = this.privateState.inventory;
        for (let i = 0; i < requires.length; i += 1) {
            const [key, amount] = requires[i];
            if (inv[key] < amount) return false;
        }
        return true;
    }

    pointerReachable = false;
    pointerBlock: BlockType | null = null;

    drawPlayerLabels(ctx: CanvasRenderingContext2D, players: Record<string, ClientPlayerState>): void {
        ctx.font = "14px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const zoom = this.camera.zoom * MC2D_TILE_SIZE_PX;
        const cx = this.camera.x;
        const cy = this.camera.y;
        const sx0 = this.userInput.screenW / 2;
        const sy0 = this.userInput.screenH / 2;
        for (const id in players) {
            const player = players[id];
            const screenX = sx0 + (player.x - cx) * zoom;
            const screenY = sy0 - (player.y + 1.45 - cy) * zoom;
            ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
            ctx.fillRect(screenX - 54, screenY - 16, 108, 16);
            ctx.fillStyle = "#f8fafc";
            ctx.fillText(player.name, screenX, screenY - 8);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(`${Math.ceil(player.hp)} HP`, screenX, screenY - 24);
        }
    }

    drawTopInfo(ctx: CanvasRenderingContext2D, me: ClientPlayerState | undefined): void {
        const secondsLeft = Math.max(0, (this.matchEndsAtMs - Date.now()) / 1000);
        ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
        ctx.fillRect(12, 10, this.userInput.screenW - 24, 52);
        ctx.fillStyle = "#f8fafc";
        ctx.font = "16px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const name = me?.name ?? this.lobbyPlayers[this.myId]?.name ?? "Player";
        const hp = me ? Math.ceil(me.hp) : 0;
        const depth = me ? Math.max(0, Math.floor(-me.y)) : 0;
        const tool = this.privateState?.pickaxeTier ?? "hand";
        const weapon = this.privateState?.weaponTier ?? "hand";
        ctx.fillText(`${name} | Time ${Math.ceil(secondsLeft)}s | HP ${hp} | Depth ${depth} | Tool ${tool} | Weapon ${weapon}`, 24, 36);
    }

    drawRecipeSidebar(ctx: CanvasRenderingContext2D): void {
        const panelW = 280;
        const panelX = this.userInput.screenW - panelW - 12;
        const panelY = 72;
        const panelH = Math.min(this.userInput.screenH - panelY, 250 + MC2D_RECIPES.length * 50);
        ctx.fillStyle = "rgba(3, 7, 18, 0.72)";
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeStyle = "rgba(248, 250, 252, 0.18)";
        ctx.lineWidth = 2;
        ctx.strokeRect(panelX, panelY, panelW, panelH);

        ctx.fillStyle = "#f8fafc";
        ctx.font = "bold 15px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("Objective: mine diamond", panelX + 12, panelY + 10);

        ctx.font = "bold 16px monospace";
        ctx.fillText("Recipes", panelX + 12, panelY + 38);

        let cursorY = panelY + 64;
        for (let i = 0; i < MC2D_RECIPES.length; i += 1) {
            const recipe = MC2D_RECIPES[i];
            const craftable = this.canCraftRecipe(recipe.id);
            const materials = RECIPE_MATERIALS_TEXT[recipe.id] ?? "";
            ctx.fillStyle = craftable ? "rgba(34, 197, 94, 0.14)" : "rgba(255, 255, 255, 0.06)";
            ctx.fillRect(panelX + 8, cursorY - 2, panelW - 16, 44);
            ctx.fillStyle = craftable ? "#86efac" : "#f8fafc";
            ctx.font = "bold 13px monospace";
            ctx.fillText(`${recipe.key}. ${recipe.label}`, panelX + 12, cursorY);
            ctx.font = "12px monospace";
            ctx.fillStyle = "#cbd5e1";
            ctx.fillText(materials, panelX + 12, cursorY + 16);
            cursorY += 50;
        }

        cursorY += 8;
        ctx.fillStyle = "#f8fafc";
        ctx.font = "bold 15px monospace";
        ctx.fillText("Base controls", panelX + 12, cursorY);

        ctx.font = "12px monospace";
        ctx.fillStyle = "#cbd5e1";
        for (let i = 0; i < BASE_CONTROLS.length; i += 1) ctx.fillText(BASE_CONTROLS[i], panelX + 12, cursorY + 20 + i * 16);
    }

    drawHotbar(ctx: CanvasRenderingContext2D): void {
        if (!this.privateState) return;
        const slotSize = 58;
        const spacing = 8;
        const totalW = HOTBAR_SLOTS.length * slotSize + (HOTBAR_SLOTS.length - 1) * spacing;
        const startX = (this.userInput.screenW - totalW) / 2;
        const y = this.userInput.screenH - 90;

        HOTBAR_SLOTS.forEach((slot, index) => {
            const x = startX + index * (slotSize + spacing);
            const quantity = this.privateState!.inventory[slot.key as keyof typeof this.privateState.inventory] as number;
            ctx.fillStyle = "rgba(15, 23, 42, 0.84)";
            ctx.fillRect(x, y, slotSize, slotSize);

            const selected = isSlotSelected(slot.key, this.privateState!.selectedPlaceable);
            ctx.strokeStyle = selected ? "#facc15" : "rgba(248, 250, 252, 0.35)";
            ctx.lineWidth = selected ? 3 : 2;
            ctx.strokeRect(x, y, slotSize, slotSize);

            ctx.fillStyle = slot.tint;
            ctx.fillRect(x + 8, y + 8, 42, 20);
            ctx.fillStyle = "#f8fafc";
            ctx.font = "bold 10px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(slot.label, x + slotSize / 2, y + 20);
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.font = "15px monospace";
            ctx.fillText(`${quantity}`, x + slotSize - 7, y + slotSize - 7);
        });
    }

    drawPickaxeSlot(ctx: CanvasRenderingContext2D): void {
        if (!this.privateState) return;
        const slotSize = 64;
        const x = this.userInput.screenW / 2 + 190;
        const y = this.userInput.screenH - 94;
        this.drawGearSlot(ctx, x, y, slotSize, "Pickaxe", this.privateState.pickaxeTier, "#e2e8f0");
        this.drawGearSlot(ctx, x + slotSize + 10, y, slotSize, "Sword", this.privateState.weaponTier, "#fcd34d");
    }

    drawHoverBlockInfo(ctx: CanvasRenderingContext2D, me: ClientPlayerState | undefined): void {
        if (!this.controller.pointerTile) return;
        const label = this.pointerBlock
            ? (BLOCK_LABELS[this.pointerBlock] ?? this.pointerBlock)
            : "Unknown";
        const reachableText = this.pointerReachable ? "in reach" : "out of reach";
        const x = this.userInput.mouseX + 14;
        const y = this.userInput.mouseY - 8;
        ctx.fillStyle = this.pointerReachable
            ? "rgba(15, 23, 42, 0.88)"
            : "rgba(127, 29, 29, 0.86)";
        ctx.fillRect(x, y - 24, 210, 44);
        ctx.fillStyle = "#f8fafc";
        ctx.font = "14px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, x + 8, y - 20);
        ctx.fillText(reachableText, x + 8, y - 2);
        if (!this.pointerReachable && me) {
            const dx = me.x - (this.controller.pointerTile.x + 0.5);
            const dy = me.y - (this.controller.pointerTile.y + 0.5);
            const dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillText(`dist ${dist.toFixed(2)}`, x + 120, y - 2);
        }
    }

    drawSummaryOverlay(ctx: CanvasRenderingContext2D): void {
        if (!this.summary) return;
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.fillRect(0, 0, this.userInput.screenW, this.userInput.screenH);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 42px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (this.summary.winnerId) {
            const winnerName = this.interpolator.getPlayers()[this.summary.winnerId]?.name
                || this.lobbyPlayers[this.summary.winnerId]?.name
                || "Unknown";
            ctx.fillText(`${winnerName} wins`, this.userInput.screenW / 2, this.userInput.screenH / 2 - 24);
        } else {
            ctx.fillText("Draw", this.userInput.screenW / 2, this.userInput.screenH / 2 - 24);
        }
        ctx.font = "20px monospace";
        ctx.fillText(this.summary.reason === "diamond_found"
            ? "A diamond has been mined"
            : "Time up, nearest to diamond wins", this.userInput.screenW / 2, this.userInput.screenH / 2 + 20);
        ctx.fillText("Match over", this.userInput.screenW / 2, this.userInput.screenH / 2 + 56);

        const buttonW = Math.min(300, this.userInput.screenW - 48);
        const buttonH = 52;
        const buttonX = this.userInput.screenW / 2 - buttonW / 2;
        const buttonY = this.userInput.screenH / 2 + 92;
        this.exitButton.draw(ctx, buttonX, buttonY, buttonW, buttonH);
    }

    drawWaitingScreen(ctx: CanvasRenderingContext2D): void {
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, this.userInput.screenW, this.userInput.screenH);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "28px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Preparing Minecraft Diamond Rush", this.userInput.screenW / 2, this.userInput.screenH / 2);
    }

    applySnapshot(snapshot: GameSnapshot): void {
        this.matchEndsAtMs = snapshot.matchEndsAtMs;
        this.summary = snapshot.summary;
        this.privateState = snapshot.self;
        this.diamondPos = snapshot.diamondPos ?? this.diamondPos;
        this.interpolator.sync(snapshot.players);
        this.chunks = {};
        for (let i = 0; i < snapshot.chunks.length; i += 1) {
            const chunk = snapshot.chunks[i];
            this.chunks[chunkKey(chunk.chunkX, chunk.chunkY)] = chunk;
        }
    }

    applyDelta(delta: GameDelta): void {
        this.matchEndsAtMs = delta.matchEndsAtMs;
        this.summary = delta.summary;
        this.diamondPos = delta.diamondPos ?? this.diamondPos;
        if (delta.self) this.privateState = delta.self;
        this.interpolator.sync(delta.players);
        for (let i = 0; i < delta.blockUpdates.length; i += 1) this.applyBlockUpdate(delta.blockUpdates[i]);
    }

    applyBlockUpdate(update: { pos: TilePos; block: BlockType }): void {
        const chunkX = floorDiv(update.pos.x, MC2D_CHUNK_SIZE);
        const chunkY = floorDiv(update.pos.y, MC2D_CHUNK_SIZE);
        const key = chunkKey(chunkX, chunkY);
        if (!this.chunks[key]) {
            this.chunks[key] = {
                chunkX,
                chunkY,
                tiles: new Array(MC2D_CHUNK_SIZE * MC2D_CHUNK_SIZE).fill("air")
            };
        }

        const index = localTileIndex(update.pos.x, update.pos.y);
        this.chunks[key].tiles[index] = update.block;
    }

    getBlockAt(tile: TilePos): BlockType | null {
        const chunkX = floorDiv(tile.x, MC2D_CHUNK_SIZE);
        const chunkY = floorDiv(tile.y, MC2D_CHUNK_SIZE);
        const key = chunkKey(chunkX, chunkY);
        const chunk = this.chunks[key];
        if (!chunk) return null;
        const index = localTileIndex(tile.x, tile.y);
        return chunk.tiles[index] ?? null;
    }

    screenToTileInto(screenX: number, screenY: number, out: TilePos): TilePos {
        const worldX = (screenX - this.userInput.screenW / 2)
            / (MC2D_TILE_SIZE_PX * this.camera.zoom)
            + this.camera.x;
        const worldY = -((screenY - this.userInput.screenH / 2)
            / (MC2D_TILE_SIZE_PX * this.camera.zoom))
            + this.camera.y;
        out.x = Math.floor(worldX);
        out.y = Math.floor(worldY);
        return out;
    }

    drawGearSlot(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        slotSize: number,
        title: string,
        tier: string,
        tint: string
    ): void {
        ctx.fillStyle = "rgba(10, 14, 24, 0.88)";
        ctx.fillRect(x, y, slotSize, slotSize);
        ctx.strokeStyle = tint;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, slotSize, slotSize);
        ctx.fillStyle = tint;
        ctx.fillRect(x + 8, y + 8, slotSize - 16, 18);
        ctx.fillStyle = "#f8fafc";
        ctx.font = "bold 12px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(title, x + slotSize / 2, y + 8);
        ctx.font = "bold 13px monospace";
        ctx.fillText(tier === "hand" ? "HAND" : tier.toUpperCase(), x + slotSize / 2, y + 30);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.controller.dispose();
    }
}

const blockColor = (block: BlockType): string => {
    switch (block) {
        case "grass": return "#6cab4f";
        case "dirt": return "#7d5a3a";
        case "trunk": return "#8a5b36";
        case "stone": return "#8c96a0";
        case "iron_ore": return "#b77f50";
        case "diamond": return "#2bc4d1";
        default: return "#111827";
    }
};

const isSlotSelected = (inventoryKey: string, selectedPlaceable: PlaceableBlock): boolean => {
    return inventoryKey === selectedPlaceable;
};
