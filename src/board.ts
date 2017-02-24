import { pos2key, key2pos, opposite, containsX } from './util'
import premove from './premove'
import * as hold from './hold'

type Callback = (...args: any[]) => void;

function callUserFunction(f: Callback | undefined, ...args: any[]): void {
  if (f) setTimeout(() => f(...args), 1);
}

export function toggleOrientation(state: State): void {
  state.orientation = opposite(state.orientation);
  state.animation.current = undefined;
}

export function reset(state: State): void {
  state.lastMove = undefined;
  unselect(state);
  unsetPremove(state);
  unsetPredrop(state);
}

export function setPieces(state: State, pieces: Pieces): void {
  for (let key in pieces) {
    if (pieces[key]) state.pieces[key] = pieces[key];
    else delete state.pieces[key];
  }
  state.movable.dropped = undefined;
}

export function setCheck(state: State, color: Color | boolean): void {
  if (color === true) color = state.turnColor;
  if (!color) state.check = undefined;
  else for (let k in state.pieces) {
    if (state.pieces[k].role === 'king' && state.pieces[k].color === color) {
      state.check = k as Key;
    }
  }
}

function setPremove(state: State, orig: Key, dest: Key, meta: any): void {
  unsetPredrop(state);
  state.premovable.current = [orig, dest];
  callUserFunction(state.premovable.events.set, orig, dest, meta);
}

export function unsetPremove(state: State): void {
  if (state.premovable.current) {
    state.premovable.current = undefined;
    callUserFunction(state.premovable.events.unset);
  }
}

function setPredrop(state: State, role: Role, key: Key): void {
  unsetPremove(state);
  state.predroppable.current = {
    role: role,
    key: key
  };
  callUserFunction(state.predroppable.events.set, role, key);
}

export function unsetPredrop(state: State): void {
  const pd = state.predroppable;
  if (pd.current) {
    pd.current = undefined;
    callUserFunction(pd.events.unset);
  }
}

function tryAutoCastle(state: State, orig: Key, dest: Key): void {
  if (!state.autoCastle) return;
  const king = state.pieces[dest];
  if (king.role !== 'king') return;
  const origPos = key2pos(orig);
  if (origPos[0] !== 5) return;
  if (origPos[1] !== 1 && origPos[1] !== 8) return;
  const destPos = key2pos(dest);
  let oldRookPos, newRookPos, newKingPos;
  if (destPos[0] === 7 || destPos[0] === 8) {
    oldRookPos = pos2key([8, origPos[1]]);
    newRookPos = pos2key([6, origPos[1]]);
    newKingPos = pos2key([7, origPos[1]]);
  } else if (destPos[0] === 3 || destPos[0] === 1) {
    oldRookPos = pos2key([1, origPos[1]]);
    newRookPos = pos2key([4, origPos[1]]);
    newKingPos = pos2key([3, origPos[1]]);
  } else return;
  delete state.pieces[orig];
  delete state.pieces[dest];
  delete state.pieces[oldRookPos];
  state.pieces[newKingPos] = {
    role: 'king',
    color: king.color
  };
  state.pieces[newRookPos] = {
    role: 'rook',
    color: king.color
  };
}

export function baseMove(state: State, orig: Key, dest: Key): boolean {
  if (orig === dest || !state.pieces[orig]) return false;
  const captured: Piece | undefined = (
    state.pieces[dest] &&
    state.pieces[dest].color !== state.pieces[orig].color
  ) ? state.pieces[dest] : undefined;
  callUserFunction(state.events.move, orig, dest, captured);
  state.pieces[dest] = state.pieces[orig];
  delete state.pieces[orig];
  state.lastMove = [orig, dest];
  state.check = undefined;
  tryAutoCastle(state, orig, dest);
  callUserFunction(state.events.change);
  state.movable.dropped = undefined;
  return true;
}

export function baseNewPiece(state: State, piece: Piece, key: Key, force?: boolean): boolean {
  if (state.pieces[key]) {
    if (force) delete state.pieces[key];
    else return false;
  }
  callUserFunction(state.events.dropNewPiece, piece, key);
  state.pieces[key] = piece;
  state.lastMove = [key, key];
  state.check = undefined;
  callUserFunction(state.events.change);
  state.movable.dropped = undefined;
  state.movable.dests = undefined;
  state.turnColor = opposite(state.turnColor);
  return true;
}

function baseUserMove(state: State, orig: Key, dest: Key): boolean {
  const result = baseMove(state, orig, dest);
  if (result) {
    state.movable.dests = undefined;
    state.turnColor = opposite(state.turnColor);
  }
  return result;
}

export function userMove(state: State, orig: Key, dest: Key): boolean {
  if (canMove(state, orig, dest)) {
    if (baseUserMove(state, orig, dest)) {
      const holdTime = hold.stop();
      unselect(state);
      const metadata: MoveMetadata = {
        premove: false,
        ctrlKey: state.stats.ctrlKey,
        holdTime: holdTime
      };
      callUserFunction(state.movable.events.after, orig, dest, metadata);
      return true;
    }
  } else if (canPremove(state, orig, dest)) {
    setPremove(state, orig, dest, {
      ctrlKey: state.stats.ctrlKey
    });
    unselect(state);
  } else if (isMovable(state, dest) || isPremovable(state, dest)) {
    setSelected(state, dest);
    hold.start();
  } else unselect(state);
  return false;
}

export function dropNewPiece(state: State, orig: Key, dest: Key, force?: boolean): void {
  if (canDrop(state, orig, dest) || force) {
    const piece = state.pieces[orig];
    delete state.pieces[orig];
    baseNewPiece(state, piece, dest, force);
    state.movable.dropped = undefined;
    callUserFunction(state.movable.events.afterNewPiece, piece.role, dest, {
      predrop: false
    });
  } else if (canPredrop(state, orig, dest)) {
    setPredrop(state, state.pieces[orig].role, dest);
  } else {
    unsetPremove(state);
    unsetPredrop(state);
  }
  delete state.pieces[orig];
  unselect(state);
}

export function selectSquare(state: State, key: Key, force?: boolean): void {
  if (state.selected) {
    if (state.selected === key && !state.draggable.enabled) {
      unselect(state);
      hold.cancel();
    } else if ((state.selectable.enabled || force) && state.selected !== key) {
      if (userMove(state, state.selected, key)) state.stats.dragged = false;
    } else hold.start();
  } else if (isMovable(state, key) || isPremovable(state, key)) {
    setSelected(state, key);
    hold.start();
  }
  if (key) callUserFunction(state.events.select, key);
}

export function setSelected(state: State, key: Key): void {
  state.selected = key;
  if (isPremovable(state, key)) {
    state.premovable.dests = premove(state.pieces, key, state.premovable.castle);
  }
  else state.premovable.dests = undefined;
}

export function unselect(state: State): void {
  state.selected = undefined;
  state.premovable.dests = undefined;
  hold.cancel();
}

function isMovable(state: State, orig: Key): boolean {
  const piece = state.pieces[orig];
  return piece && (
    state.movable.color === 'both' || (
      state.movable.color === piece.color &&
        state.turnColor === piece.color
    ));
}

function canMove(state: State, orig: Key, dest: Key): boolean {
  return orig !== dest && isMovable(state, orig) && (
    state.movable.free || (!!state.movable.dests && containsX(state.movable.dests[orig], dest))
  );
}

function canDrop(state: State, orig: Key, dest: Key): boolean {
  const piece = state.pieces[orig];
  return piece && dest && (orig === dest || !state.pieces[dest]) && (
    state.movable.color === 'both' || (
      state.movable.color === piece.color &&
        state.turnColor === piece.color
    ));
}


function isPremovable(state: State, orig: Key): boolean {
  const piece = state.pieces[orig];
  return piece && state.premovable.enabled &&
  state.movable.color === piece.color &&
    state.turnColor !== piece.color;
}

function canPremove(state: State, orig: Key, dest: Key): boolean {
  return orig !== dest &&
  isPremovable(state, orig) &&
  containsX(premove(state.pieces, orig, state.premovable.castle), dest);
}

function canPredrop(state: State, orig: Key, dest: Key): boolean {
  const piece = state.pieces[orig];
  return piece && dest &&
  (!state.pieces[dest] || state.pieces[dest].color !== state.movable.color) &&
  state.predroppable.enabled &&
  (piece.role !== 'pawn' || (dest[1] !== '1' && dest[1] !== '8')) &&
  state.movable.color === piece.color &&
    state.turnColor !== piece.color;
}

export function isDraggable(state: State, orig: Key): boolean {
  const piece = state.pieces[orig];
  return piece && state.draggable.enabled && (
    state.movable.color === 'both' || (
      state.movable.color === piece.color && (
        state.turnColor === piece.color || state.premovable.enabled
      )
    )
  );
}

export function playPremove(state: State): boolean {
  const move = state.premovable.current;
  if (!move) return false;
  const orig = move[0], dest = move[1];
  let success = false;
  if (canMove(state, orig, dest)) {
    if (baseUserMove(state, orig, dest)) {
      const metadata: MoveMetadata = { premove: true };
      callUserFunction(state.movable.events.after, orig, dest, metadata);
      success = true;
    }
  }
  unsetPremove(state);
  return success;
}

export function playPredrop(state: State, validate: (drop: Drop) => boolean): boolean {
  let drop = state.predroppable.current,
  success = false;
  if (!drop) return false;
  if (validate(drop)) {
    const piece = {
      role: drop.role,
      color: state.movable.color as Color
    };
    if (baseNewPiece(state, piece, drop.key)) {
      callUserFunction(state.movable.events.afterNewPiece, drop.role, drop.key, {
        predrop: true
      });
      success = true;
    }
  }
  unsetPredrop(state);
  return success;
}

export function cancelMove(state: State): void {
  unsetPremove(state);
  unsetPredrop(state);
  unselect(state);
}

export function stop(state: State): void {
  state.movable.color = undefined;
  state.movable.dests = undefined;
  cancelMove(state);
}

export function getKeyAtDomPos(state: State, pos: NumberPair): Key | undefined {
  let file = Math.ceil(8 * ((pos[0] - state.dom.bounds.left) / state.dom.bounds.width));
  file = state.orientation === 'white' ? file : 9 - file;
  let rank = Math.ceil(8 - (8 * ((pos[1] - state.dom.bounds.top) / state.dom.bounds.height)));
  rank = state.orientation === 'white' ? rank : 9 - rank;
  return (file > 0 && file < 9 && rank > 0 && rank < 9) ? pos2key([file, rank]) : undefined;
}

// {white: {pawn: 3 queen: 1}, black: {bishop: 2}}
export function getMaterialDiff(state: State): MaterialDiff {
  let counts = {
    king: 0,
    queen: 0,
    rook: 0,
    bishop: 0,
    knight: 0,
    pawn: 0
  }, p: Piece, role: Role, c: number;
  for (let k in state.pieces) {
    p = state.pieces[k];
    counts[p.role] += ((p.color === 'white') ? 1 : -1);
  }
  let diff: MaterialDiff = {
    white: {},
    black: {}
  };
  for (role in counts) {
    c = counts[role];
    if (c > 0) diff.white[role] = c;
    else if (c < 0) diff.black[role] = -c;
  }
  return diff;
}

const pieceScores = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0
};

export function getScore(state: State): number {
  let score = 0;
  for (let k in state.pieces) {
    score += pieceScores[state.pieces[k].role] * (state.pieces[k].color === 'white' ? 1 : -1);
  }
  return score;
}