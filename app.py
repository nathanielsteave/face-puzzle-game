from flask import Flask, render_template, Response, request, jsonify
import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import numpy as np
import random

app = Flask(__name__)

# ================= CONFIG =================
GRID_SIZE = 3
STABLE_FRAMES_NEEDED = 45        
MIN_SQUARE_AREA = 4000
SWIPE_THRESHOLD = 40             
COOLDOWN_FRAMES = 12             
PUZZLE_SIZE = 320                
GAP = 4                          
# ==========================================

# Global state
WAITING, PUZZLE = 0, 1
state = WAITING
stable_counter = 0
last_rect = None
captured_img = None              
puzzle_board = None
empty_pos = None
solved_board = None
prev_finger_pos = None
swipe_cooldown = 0
status_message = "Form a square with both hands and hold steady"
is_solved = False  # <--- VARIABEL BARU UNTUK CEK STATUS SELESAI

base_options = python.BaseOptions(model_asset_path='hand_landmarker.task')
options = vision.HandLandmarkerOptions(
    base_options=base_options,
    num_hands=2,
    min_hand_detection_confidence=0.7,
    min_tracking_confidence=0.5
)
hand_landmarker = vision.HandLandmarker.create_from_options(options)

camera = cv2.VideoCapture(0)
camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

def create_puzzle_board():
    global GRID_SIZE
    board = [[r * GRID_SIZE + c for c in range(GRID_SIZE)] for r in range(GRID_SIZE)]
    board[GRID_SIZE-1][GRID_SIZE-1] = -1
    
    shuffle_moves = 100 if GRID_SIZE == 3 else (200 if GRID_SIZE == 4 else 350)
    for _ in range(shuffle_moves):
        er, ec = None, None
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                if board[r][c] == -1: er, ec = r, c
        moves = []
        if er > 0: moves.append((er-1, ec))
        if er < GRID_SIZE-1: moves.append((er+1, ec))
        if ec > 0: moves.append((er, ec-1))
        if ec < GRID_SIZE-1: moves.append((er, ec+1))
        mr, mc = random.choice(moves)
        board[er][ec], board[mr][mc] = board[mr][mc], board[er][ec]
    empty = [(r, c) for r in range(GRID_SIZE) for c in range(GRID_SIZE) if board[r][c] == -1][0]
    return board, empty

def slice_image(img, board):
    global GRID_SIZE
    tile_size = PUZZLE_SIZE // GRID_SIZE
    puzzle_img = np.full((PUZZLE_SIZE, PUZZLE_SIZE, 3), 220, dtype=np.uint8)
    
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            piece_id = board[r][c]
            if piece_id == -1: continue
            orow, ocol = piece_id // GRID_SIZE, piece_id % GRID_SIZE
            piece = img[orow*tile_size:(orow+1)*tile_size, ocol*tile_size:(ocol+1)*tile_size]
            piece_resized = cv2.resize(piece, (max(1, tile_size - GAP*2), max(1, tile_size - GAP*2)))
            
            y_start, y_end = r * tile_size + GAP, (r + 1) * tile_size - GAP
            x_start, x_end = c * tile_size + GAP, (c + 1) * tile_size - GAP
            puzzle_img[y_start:y_end, x_start:x_end] = piece_resized
    return puzzle_img

def process_frame():
    global GRID_SIZE, state, stable_counter, last_rect, captured_img, puzzle_board, empty_pos, solved_board
    global prev_finger_pos, swipe_cooldown, status_message, is_solved

    ret, frame = camera.read()
    if not ret: return None

    frame = cv2.flip(frame, 1)
    h, w = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    detection = hand_landmarker.detect(mp_img)

    if state == WAITING:
        if detection.hand_landmarks and len(detection.hand_landmarks) >= 2:
            h1, h2 = detection.hand_landmarks[0], detection.hand_landmarks[1]
            def tip(hand, idx): return (int(hand[idx].x * w), int(hand[idx].y * h))
            pts = tip(h1,4) + tip(h1,8) + tip(h2,4) + tip(h2,8)
            xs, ys = pts[0::2], pts[1::2]
            xmin, xmax, ymin, ymax = min(xs), max(xs), min(ys), max(ys)
            
            if xmax - xmin > 20 and ymax - ymin > 20:
                rect = (xmin, ymin, xmax - xmin, ymax - ymin)
                if rect[2] * rect[3] >= MIN_SQUARE_AREA:
                    cv2.rectangle(frame, (rect[0], rect[1]), (rect[0]+rect[2], rect[1]+rect[3]), (255, 255, 255), 2)
                    if last_rect and all(abs(rect[i] - last_rect[i]) < 15 for i in range(4)):
                        stable_counter += 1
                    else: stable_counter = 0
                    last_rect = rect
        else: stable_counter = 0

        if stable_counter > 0:
            progress = min(stable_counter / STABLE_FRAMES_NEEDED, 1.0)
            bar_x, bar_y = int(w/2 - 100), h - 40
            cv2.rectangle(frame, (bar_x, bar_y), (bar_x+200, bar_y+8), (255, 255, 255), 1)
            cv2.rectangle(frame, (bar_x, bar_y), (bar_x+int(200*progress), bar_y+8), (255, 122, 0), -1)
        
        status_message = f"Form a square. Mode: {GRID_SIZE}x{GRID_SIZE}"

        if stable_counter >= STABLE_FRAMES_NEEDED and last_rect:
            x, y, rw, rh = last_rect
            crop = frame[y:y+rh, x:x+rw].copy()
            if crop.size != 0: captured_img = cv2.resize(crop, (PUZZLE_SIZE, PUZZLE_SIZE))
            puzzle_board, empty_pos = create_puzzle_board()
            solved_board = [[r*GRID_SIZE + c for c in range(GRID_SIZE)] for r in range(GRID_SIZE)]
            solved_board[GRID_SIZE-1][GRID_SIZE-1] = -1
            state, stable_counter, status_message = PUZZLE, 0, "Swipe with index finger to move pieces"

    elif state == PUZZLE:
        if captured_img is not None:
            puzzle_display = slice_image(captured_img, puzzle_board)
            big_frame = np.full((480, 1000, 3), (250, 249, 245), dtype=np.uint8)
            big_frame[0:480, 0:640] = frame
            y_puz = (480 - PUZZLE_SIZE) // 2
            big_frame[y_puz:y_puz+PUZZLE_SIZE, 660:660+PUZZLE_SIZE] = puzzle_display
            frame = big_frame

        if detection.hand_landmarks and not is_solved:
            hand = detection.hand_landmarks[0]
            curr_pos = (int(hand[8].x * w), int(hand[8].y * 480))
            cv2.circle(frame, curr_pos, 8, (255, 122, 0), -1)
            cv2.circle(frame, curr_pos, 12, (255, 255, 255), 3)

            if prev_finger_pos and swipe_cooldown == 0:
                dx, dy = curr_pos[0] - prev_finger_pos[0], curr_pos[1] - prev_finger_pos[1]
                if np.sqrt(dx**2 + dy**2) > SWIPE_THRESHOLD:
                    direction = 'RIGHT' if abs(dx) > abs(dy) and dx > 0 else 'LEFT' if abs(dx) > abs(dy) and dx < 0 else 'DOWN' if dy > 0 else 'UP'
                    er, ec = empty_pos
                    mr, mc = er, ec
                    if direction == 'UP' and er < GRID_SIZE-1: mr, mc = er+1, ec
                    elif direction == 'DOWN' and er > 0: mr, mc = er-1, ec
                    elif direction == 'LEFT' and ec < GRID_SIZE-1: mr, mc = er, ec+1
                    elif direction == 'RIGHT' and ec > 0: mr, mc = er, ec-1
                    
                    if (mr, mc) != (er, ec):
                        puzzle_board[er][ec], puzzle_board[mr][mc] = puzzle_board[mr][mc], puzzle_board[er][ec]
                        empty_pos, swipe_cooldown = (mr, mc), COOLDOWN_FRAMES
                        
                        # --- CEK KEMENANGAN ---
                        if puzzle_board == solved_board: 
                            status_message = "Solved! Processing completion..."
                            is_solved = True
                            
            prev_finger_pos = curr_pos
        else: prev_finger_pos = None
        if swipe_cooldown > 0: swipe_cooldown -= 1

    ret, jpeg = cv2.imencode('.jpg', frame)
    return jpeg.tobytes()

def gen_frames():
    while True:
        frame_bytes = process_frame()
        if frame_bytes: yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')

@app.route('/')
def index(): return render_template('index.html')

@app.route('/video_feed')
def video_feed(): return Response(gen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/restart')
def restart():
    global state, status_message, GRID_SIZE, is_solved
    state, status_message = WAITING, f"Form a square. Mode: {GRID_SIZE}x{GRID_SIZE}"
    is_solved = False
    return '', 204

@app.route('/set_grid/<int:size>', methods=['POST'])
def set_grid(size):
    global GRID_SIZE, state, status_message, captured_img, puzzle_board, is_solved
    if size in [3, 4, 5, 6]:
        GRID_SIZE = size
        state = WAITING
        captured_img = None
        puzzle_board = None
        is_solved = False
        status_message = f"Difficulty changed to {size}x{size}. Form a square."
        return jsonify({"status": "success", "size": size})
    return jsonify({"status": "error"}), 400

@app.route('/status')
def status(): 
    # API sekarang mengembalikan status is_solved ke Frontend
    return jsonify({'message': status_message, 'solved': is_solved})

if __name__ == '__main__':
    app.run(debug=True, threaded=True)