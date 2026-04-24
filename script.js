/* ========================================================
   UI LOGIC
   ======================================================== */
const introScreen = document.getElementById('intro-screen');
const gameScreen = document.getElementById('game-screen');
const successOverlay = document.getElementById('success-overlay');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const loadingText = document.getElementById('loading-text');

let cameraStarted = false;

// Global functions need to be attached to window if called directly from HTML onclick
window.enterGame = function () {
    introScreen.classList.add('intro-hidden');
    gameScreen.classList.add('game-visible');
    document.body.style.overflow = 'auto';

    if (!cameraStarted) {
        camera.start();
        cameraStarted = true;
    }
    restartGame();
}

window.backToIntro = function () {
    gameScreen.classList.remove('game-visible');
    introScreen.classList.remove('intro-hidden');
    hideSuccessOverlay();
    restartGame();
}

window.toggleTutorial = function () {
    const panel = document.getElementById('tutorialPanel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

window.hideSuccessOverlay = function () {
    successOverlay.classList.remove('show');
}

window.hideSuccessAndRestart = function () {
    hideSuccessOverlay();
    restartGame();
}

window.changeGrid = function (size, element) {
    document.querySelectorAll('.seg-btn').forEach(btn => btn.classList.remove('active'));
    element.classList.add('active');
    GRID_SIZE = size;
    restartGame();
}

/* ========================================================
   GAME LOGIC & COMPUTER VISION
   ======================================================== */
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

// CONFIG
let GRID_SIZE = 3;
const PUZZLE_SIZE = 320;
const STABLE_FRAMES_NEEDED = 35; // Frames (~1.2s)
const MIN_SQUARE_AREA = 10000;
const SWIPE_THRESHOLD = 45;
const COOLDOWN_FRAMES = 12;
const GAP = 2;

// STATE
let state = "WAITING";
let stableCounter = 0;
let lastRect = null;
let puzzleBoard = [];
let solvedBoard = [];
let emptyPos = null;
let prevFingerPos = null;
let swipeCooldown = 0;
let isSolved = false;

// Offscreen canvas untuk menyimpan potongan gambar
const cropCanvas = document.createElement('canvas');
cropCanvas.width = PUZZLE_SIZE;
cropCanvas.height = PUZZLE_SIZE;
const cropCtx = cropCanvas.getContext('2d');

window.restartGame = function () {
    state = "WAITING";
    stableCounter = 0;
    lastRect = null;
    puzzleBoard = [];
    isSolved = false;
    swipeCooldown = 0;
    statusEl.textContent = `Form a square. Mode: ${GRID_SIZE}x${GRID_SIZE}`;
}

function createPuzzleBoard() {
    let board = [];
    solvedBoard = [];
    for (let r = 0; r < GRID_SIZE; r++) {
        let row = [];
        let solRow = [];
        for (let c = 0; c < GRID_SIZE; c++) {
            row.push(r * GRID_SIZE + c);
            solRow.push(r * GRID_SIZE + c);
        }
        board.push(row);
        solvedBoard.push(solRow);
    }
    board[GRID_SIZE - 1][GRID_SIZE - 1] = -1;
    solvedBoard[GRID_SIZE - 1][GRID_SIZE - 1] = -1;

    // Shuffle
    let shuffleMoves = GRID_SIZE === 3 ? 100 : (GRID_SIZE === 4 ? 200 : 300);
    for (let i = 0; i < shuffleMoves; i++) {
        let er, ec;
        for (let r = 0; r < GRID_SIZE; r++) {
            for (let c = 0; c < GRID_SIZE; c++) {
                if (board[r][c] === -1) { er = r; ec = c; }
            }
        }
        let moves = [];
        if (er > 0) moves.push([er - 1, ec]);
        if (er < GRID_SIZE - 1) moves.push([er + 1, ec]);
        if (ec > 0) moves.push([er, ec - 1]);
        if (ec < GRID_SIZE - 1) moves.push([er, ec + 1]);

        let move = moves[Math.floor(Math.random() * moves.length)];
        let mr = move[0], mc = move[1];

        // Swap
        let temp = board[er][ec];
        board[er][ec] = board[mr][mc];
        board[mr][mc] = temp;
    }

    emptyPos = null;
    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            if (board[r][c] === -1) emptyPos = [r, c];
        }
    }
    return board;
}

function checkWin() {
    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            if (puzzleBoard[r][c] !== solvedBoard[r][c]) return false;
        }
    }
    return true;
}

function onResults(results) {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Background Canvas Color (Soft Gray)
    canvasCtx.fillStyle = "#faf9f5";
    canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);

    const CAM_W = 640;
    const CAM_H = 480;

    if (state === "WAITING") {
        // Mode Kamera Penuh
        canvasCtx.translate(CAM_W, 0);
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(results.image, 0, 0, CAM_W, CAM_H);
        canvasCtx.setTransform(1, 0, 0, 1, 0, 0);

        let rect = null;
        if (results.multiHandLandmarks && results.multiHandLandmarks.length >= 2) {
            let h1 = results.multiHandLandmarks[0];
            let h2 = results.multiHandLandmarks[1];

            // Titik ujung jempol (4) dan telunjuk (8)
            let xs = [h1[4].x, h1[8].x, h2[4].x, h2[8].x];
            let ys = [h1[4].y, h1[8].y, h2[4].y, h2[8].y];

            // Karena gambar di-flip horizontal, x koordinat harus di-invert
            let minX = Math.min(...xs.map(x => 1 - x)) * CAM_W;
            let maxX = Math.max(...xs.map(x => 1 - x)) * CAM_W;
            let minY = Math.min(...ys) * CAM_H;
            let maxY = Math.max(...ys) * CAM_H;

            let w = maxX - minX;
            let h = maxY - minY;

            if (w > 20 && h > 20) {
                rect = { x: minX, y: minY, w: w, h: h };
                if (w * h >= MIN_SQUARE_AREA) {
                    // Gambar Box Putih
                    canvasCtx.strokeStyle = "white";
                    canvasCtx.lineWidth = 3;
                    canvasCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

                    if (lastRect) {
                        let diff = Math.abs(rect.x - lastRect.x) + Math.abs(rect.y - lastRect.y) + Math.abs(rect.w - lastRect.w) + Math.abs(rect.h - lastRect.h);
                        if (diff < 60) stableCounter++;
                        else stableCounter = 0;
                    } else {
                        stableCounter = 0;
                    }
                    lastRect = rect;
                } else {
                    stableCounter = 0; lastRect = null;
                }
            } else {
                stableCounter = 0; lastRect = null;
            }
        } else {
            stableCounter = 0; lastRect = null;
        }

        // Gambar Progress Bar
        if (stableCounter > 0) {
            let progress = Math.min(stableCounter / STABLE_FRAMES_NEEDED, 1.0);
            let barX = CAM_W / 2 - 100;
            let barY = CAM_H - 40;
            canvasCtx.strokeStyle = "white";
            canvasCtx.lineWidth = 2;
            canvasCtx.strokeRect(barX, barY, 200, 10);
            canvasCtx.fillStyle = "#007aff"; // Accent blue
            canvasCtx.fillRect(barX, barY, 200 * progress, 10);
        }

        if (stableCounter >= STABLE_FRAMES_NEEDED && lastRect) {
            // Ambil crop gambar aslinya (dibalik agar tidak mirror)
            cropCtx.save();
            cropCtx.translate(PUZZLE_SIZE, 0);
            cropCtx.scale(-1, 1);
            // Hitung rasio asli
            let originalX = (1 - (lastRect.x + lastRect.w) / CAM_W) * results.image.width;
            let originalY = (lastRect.y / CAM_H) * results.image.height;
            let originalW = (lastRect.w / CAM_W) * results.image.width;
            let originalH = (lastRect.h / CAM_H) * results.image.height;

            cropCtx.drawImage(results.image, originalX, originalY, originalW, originalH, 0, 0, PUZZLE_SIZE, PUZZLE_SIZE);
            cropCtx.restore();

            puzzleBoard = createPuzzleBoard();
            state = "PUZZLE";
            stableCounter = 0;
            lastRect = null;
            prevFingerPos = null;
            swipeCooldown = 0;
            statusEl.textContent = "Swipe with index finger to move pieces";
        }

    } else if (state === "PUZZLE") {
        // Draw Camera (Kiri)
        canvasCtx.translate(CAM_W, 0);
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(results.image, 0, 0, CAM_W, CAM_H);
        canvasCtx.setTransform(1, 0, 0, 1, 0, 0);

        // Draw Puzzle (Kanan)
        let puzzleOffsetX = 660;
        let puzzleOffsetY = (CAM_H - PUZZLE_SIZE) / 2;
        let tileSize = PUZZLE_SIZE / GRID_SIZE;

        // Background abu-abu untuk area puzzle
        canvasCtx.fillStyle = "#e0e0e0";
        canvasCtx.fillRect(puzzleOffsetX, puzzleOffsetY, PUZZLE_SIZE, PUZZLE_SIZE);

        for (let r = 0; r < GRID_SIZE; r++) {
            for (let c = 0; c < GRID_SIZE; c++) {
                let pieceId = puzzleBoard[r][c];
                if (pieceId === -1) continue;

                let orow = Math.floor(pieceId / GRID_SIZE);
                let ocol = pieceId % GRID_SIZE;

                let sx = ocol * tileSize;
                let sy = orow * tileSize;
                let dx = puzzleOffsetX + (c * tileSize) + GAP;
                let dy = puzzleOffsetY + (r * tileSize) + GAP;
                let drawSize = tileSize - (2 * GAP);

                canvasCtx.drawImage(cropCanvas, sx, sy, tileSize, tileSize, dx, dy, Math.max(1, drawSize), Math.max(1, drawSize));
            }
        }

        // Hand Gesture untuk main
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0 && !isSolved) {
            let hand = results.multiHandLandmarks[0];
            // Ujung telunjuk (8), dibalik X-nya
            let currX = (1 - hand[8].x) * CAM_W;
            let currY = hand[8].y * CAM_H;

            // Draw Indicator
            canvasCtx.beginPath();
            canvasCtx.arc(currX, currY, 12, 0, 2 * Math.PI);
            canvasCtx.fillStyle = "white";
            canvasCtx.fill();
            canvasCtx.beginPath();
            canvasCtx.arc(currX, currY, 8, 0, 2 * Math.PI);
            canvasCtx.fillStyle = "#007aff";
            canvasCtx.fill();

            if (prevFingerPos && swipeCooldown === 0) {
                let dx = currX - prevFingerPos.x;
                let dy = currY - prevFingerPos.y;
                let dist = Math.sqrt(dx * dx + dy * dy);

                if (dist > SWIPE_THRESHOLD) {
                    let direction = '';
                    if (Math.abs(dx) > Math.abs(dy)) direction = dx > 0 ? 'RIGHT' : 'LEFT';
                    else direction = dy > 0 ? 'DOWN' : 'UP';

                    let er = emptyPos[0], ec = emptyPos[1];
                    let mr = er, mc = ec;

                    if (direction === 'UP' && er < GRID_SIZE - 1) { mr = er + 1; mc = ec; }
                    else if (direction === 'DOWN' && er > 0) { mr = er - 1; mc = ec; }
                    else if (direction === 'LEFT' && ec < GRID_SIZE - 1) { mr = er; mc = ec + 1; }
                    else if (direction === 'RIGHT' && ec > 0) { mr = er; mc = ec - 1; }

                    if (mr !== er || mc !== ec) {
                        // Swap
                        let temp = puzzleBoard[er][ec];
                        puzzleBoard[er][ec] = puzzleBoard[mr][mc];
                        puzzleBoard[mr][mc] = temp;
                        emptyPos = [mr, mc];
                        swipeCooldown = COOLDOWN_FRAMES;

                        if (checkWin()) {
                            statusEl.textContent = "Solved! Processing completion...";
                            isSolved = true;
                            setTimeout(() => {
                                successOverlay.classList.add('show');
                            }, 500);
                        }
                    }
                }
            }
            prevFingerPos = { x: currX, y: currY };
        } else {
            prevFingerPos = null;
        }

        if (swipeCooldown > 0) swipeCooldown--;
    }
    canvasCtx.restore();
}

// Inisialisasi MediaPipe Hands
const hands = new Hands({
    locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }
});

hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.5
});

hands.onResults(onResults);

const camera = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480
});

// Menghapus tombol loading setelah AI Model siap
hands.initialize().then(() => {
    startBtn.disabled = false;
    startBtn.textContent = "Start Experience";
    loadingText.style.display = "none";
});