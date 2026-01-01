const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 9090;

app.get("/", (req, res) => {
  res.send("Poker server running");
});

server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

// WebSocket server
const wss = new WebSocket.Server({
  server,
  path: "/ws"
});
const clients = {};
const games = {};
let max = 0;
let amountsAdded = {};
wss.on("connection", (connection) => {
    console.log("✅ Client connected");
    connection.on("close", () => console.log("closed!"))
    connection.on("message", (data) => {
    const result = JSON.parse(data.toString());
        const result = JSON.parse(data.toString());
        //I have received a message from the client
        //a user want to create a new game
        if (result.method === "create") {
            const clientId = result.clientId;
            const gameId = guid1();
            games[gameId] = {
                "id": gameId,
                "balls": 20,
                "clients": [],
                "room": 1,
                "pot": 0,
                "value": 0,
                "creator": clientId,
                "started": false,
                "round": 0,
                "turnIndex": 0,
                "totalRounds": 4,
                "ended": false,
                "max": 0,
                "amountaddedclient": 0,
                "roundended": false,
                "nextroundpurity": 0
            }

            // ensure derived fields (current turn name, etc.) are present
            enrichGame(games[gameId]);

            const payLoad = {
                "method": "create",
                "game" : games[gameId]
            }

            const con = clients[clientId].connection;
            con.send(JSON.stringify(payLoad));
        }

        //a client want to join
        if (result.method === "join") {

            const clientId = result.clientId;
            const gameId = result.gameId;
            const game = games[gameId];
            if (game.clients.length >= 3) 
            {
                //sorry max players reach
                return;
            }
            const color =  {"0": "Red", "1": "Green", "2": "Blue"}[game.clients.length]
            game.clients.push({
                "clientId": clientId,
                "color": color,
                "name": result.name || null
            })
            // don't auto-start; creator must press start

            // announce join in game messages
            pushGameMessage(game, (result.name || clientId) + ' joined the game');

            const payLoad = {
                "method": "join",
                "game": game,
                "gameId": gameId,
                "name": result.name
            }
            //loop through all clients and tell them that people has joined
            // make sure payload contains current turn username and messages
            enrichGame(game);
            game.clients.forEach(c => {
                clients[c.clientId].connection.send(JSON.stringify(payLoad))
            })
        }
        //a user plays
        if (result.method === "play") {
            const gameId = result.gameId;
            const ballId = result.ballId;
            const color = result.color;
            let state = games[gameId].state;
            if (!state)
                state = {}
            
            state[ballId] = color;
            games[gameId].state = state;
            
        }
        if (result.method === "add") {
            const clientId = result.clientId;
            const gameId = result.gameId;
            const game = games[gameId];
            const valueadded = result.value;
            // if attempting to add positive chips, ensure player has enough chips
            if (typeof valueadded === 'number' && valueadded > 0) {
                const available = (game && game.chips && typeof game.chips[clientId] === 'number') ? game.chips[clientId] : 0;
                if (valueadded > available) {
                    const payLoad = { method: 'error', error: 'insufficient chips', amountadded: amountsAdded[clientId] };
                    if (clients[clientId] && clients[clientId].connection) clients[clientId].connection.send(JSON.stringify(payLoad));
                    return;
                }
            }
            if(typeof amountsAdded[clientId] == 'undefined' || amountsAdded[clientId] === null || typeof amountsAdded[clientId] == undefined){
                amountsAdded[clientId] = 0;
            }
            if(typeof amountsAdded[clientId] !== 'number'){
                amountsAdded[clientId] = 0;
            }
            if(amountsAdded[clientId] + valueadded >= game.max){
            amountsAdded[clientId] += valueadded;
            }
            if(amountsAdded[clientId] > game.max) game.max = amountsAdded[clientId];
            if (!game || !game.started || game.ended) return;
            // enforce turn order
            if (amountsAdded[clientId] == game.max) {
            const currentIndex = game.turnIndex || 0;
            const currentPlayer = (game.clients || [])[currentIndex];
            if (!currentPlayer || currentPlayer.clientId !== result.clientId) {
                // ignore adds from non-current players
                return;
            }
            
            const v = Number(result.value) || 0;
            // deduct chips from player when they add > 0
            if (v > 0) {
                if (!game.chips) game.chips = {};
                const avail = typeof game.chips[clientId] === 'number' ? game.chips[clientId] : 0;
                game.chips[clientId] = Math.max(0, avail - v);
            }
            game.pot = (typeof game.pot === 'number' ? game.pot : 0) + v;
            game.value = game.pot;

            // announce add in game's messages using player's real name
            let adderName = result.name;
            if (!adderName) {
                const p = (game.clients || []).find(x => x.clientId === clientId);
                adderName = p && p.name ? p.name : clientId;
            }
            if(v==0){
                pushGameMessage(game, adderName + ' checked');
            }else{
            pushGameMessage(game, adderName + ' added ' + v + ' chips to the pot');
            }

            // advance turn
            if (!game.roundended){
            game.turnIndex = currentIndex + 1;
            }
            if (game.turnIndex >= (game.clients || []).length) {
                // completed a circular round
                game.roundended = true;
            }
            if(game.nextroundpurity > 0){
                game.nextroundpurity = 0;
            }
            if(game.roundended){
                game.clients.forEach(c => {
                    if (amountsAdded[c.clientId] < game.max) {
                        for(let i = 0; i<game.clients.length; i++){
                            if(c.clientId === game.clients[i].clientId){
                                game.turnIndex = i;
                                break;
                            }
                        }
                    }else{
                        game.nextroundpurity += 1;
                    }
                })
            }
            if(game.nextroundpurity == game.clients.length){
                game.roundended = false;
                game.turnIndex = 0;
                game.round = (game.round || 0) + 1;
                // reset per-round maximum when a round completes
                game.max = 0;
                // reset per-client amountsAdded for the new round (only for clients in this game)
                if (Array.isArray(game.clients)){
                    game.clients.forEach(c => {
                        if (c && c.clientId) amountsAdded[c.clientId] = 0;
                    })
                }
                // reveal community cards when entering certain rounds
                if (!Array.isArray(game.community)) game.community = [];
                if (!Array.isArray(game.deck)) game.deck = [];
                if (game.round === 2) {
                    // reveal flop (3 cards)
                    const flop = [];
                    for (let i=0;i<3;i++){ if (game.deck.length) flop.push(game.deck.pop()); }
                    game.community = game.community.concat(flop);
                    if (flop.length) pushGameMessage(game, 'flop: ' + flop.join(', '));
                } else if (game.round === 3) {
                    // reveal turn (1 card)
                    const turn = game.deck.length ? game.deck.pop() : null;
                    if (turn) {
                        game.community.push(turn);
                        pushGameMessage(game, 'turn: ' + turn);
                    }
                } else if (game.round === 4) {
                    // reveal river (1 card)
                    const river = game.deck.length ? game.deck.pop() : null;
                    if (river) {
                        game.community.push(river);
                        pushGameMessage(game, 'river: ' + river);
                    }
                }
                // announce round advance
                pushGameMessage(game, 'Advanced to round ' + game.round);
                // if exceeded totalRounds, end the game
                if (game.round > (game.totalRounds || 4)) {
                    // showdown: determine best hand among non-folded players if more than one remains
                    try {
                        const active = (game.clients || []).filter(p => !p.folded && game.privateHands && game.privateHands[p.clientId]);
                        if (active.length > 1) {
                            const hands = active.map(p => ({ id: p.clientId, name: p.name || p.clientId }));
                            const community = Array.isArray(game.community) ? game.community.slice() : [];
                            const scores = {};
                            hands.forEach(h => {
                                const priv = (game.privateHands && game.privateHands[h.id]) || [];
                                const all = priv.concat(community);
                                const best = bestHandScore(all);
                                scores[h.id] = best;
                            });
                            // find best score
                            let bestIdList = [];
                            let bestScore = null;
                            for (const id of Object.keys(scores)){
                                const s = scores[id];
                                if (!bestScore || compareScores(s, bestScore) > 0) {
                                    bestScore = s; bestIdList = [id];
                                } else if (compareScores(s, bestScore) === 0) {
                                    bestIdList.push(id);
                                }
                            }
                            const potAmount = typeof game.pot === 'number' ? game.pot : 0;
                            if (bestIdList.length === 1) {
                                const winnerId = bestIdList[0];
                                game.chips[winnerId] = (typeof game.chips[winnerId] === 'number' ? game.chips[winnerId] : 0) + potAmount;
                                pushGameMessage(game, (game.clients.find(x=>x.clientId===winnerId).name || winnerId) + ' wins the showdown and takes ' + potAmount + ' chips');
                            } else if (bestIdList.length > 1) {
                                const split = Math.floor(potAmount / bestIdList.length);
                                bestIdList.forEach(id => { game.chips[id] = (typeof game.chips[id] === 'number' ? game.chips[id] : 0) + split; });
                                pushGameMessage(game, 'Showdown tie — pot split: ' + split + ' each');
                            }
                            game.pot = 0; game.value = 0;
                            // broadcast updated chips and messages
                            const finalPayload = { method: 'update', game: game, gameId };
                            enrichGame(game);
                            game.clients.forEach(c => {
                                if (clients[c.clientId] && clients[c.clientId].connection) clients[c.clientId].connection.send(JSON.stringify(finalPayload));
                            });
                        }
                    } catch (e) {
                        console.error('Showdown error', e);
                    }
                    game.ended = true;
                    game.started = false;
                    // schedule automatic restart after a short pause
                    scheduleRestartIfNeeded(game.id);
                }
            }
            // broadcast an update so clients refresh the displayed number and turn/round
            const payLoad = {
                method: 'update',
                game: game,
                gameId: gameId
            };
            // ensure derived fields are included
            enrichGame(game);
            game.clients.forEach(c => {
                clients[c.clientId].connection.send(JSON.stringify(payLoad))
            })
        }else{
            const payLoad = {
            method: 'error',
            error: "insufficient add",
            amountadded: amountsAdded[clientId],
            }
            clients[clientId].connection.send(JSON.stringify(payLoad))
        }
        }
        // start the game (only creator can start)
        if (result.method === "start") {
            const gameId = result.gameId;
            const game = games[gameId];
            if (!game) return;
            if (game.creator !== result.clientId) return; // only creator
            game.started = true;
            game.ended = false;
            game.round = 1; // start on round 1
            game.turnIndex = 0;
            game.totalRounds = game.totalRounds || 4;
            game.pot = typeof game.pot === 'number' ? game.pot : 0;
            game.value = game.pot;
            // broadcast start to all clients so UI can update
            const payLoad = {
                method: 'start',
                game: game,
                gameId: gameId
            };
            // deal two cards to each player from a standard deck
            // build deck
            const suits = ['S','H','D','C'];
            const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
            let deck = [];
            suits.forEach(s => ranks.forEach(r => deck.push(r + s)));
            // shuffle
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            // allocate private hands map and store remaining deck and empty community
            game.privateHands = {};
            (game.clients || []).forEach(c => {
                const card1 = deck.pop();
                const card2 = deck.pop();
                game.privateHands[c.clientId] = [card1, card2];
            });
            // initialize chips for each player at game start if not already present
            game.chips = game.chips || {};
            (game.clients || []).forEach(c => { if (c && c.clientId && typeof game.chips[c.clientId] !== 'number') game.chips[c.clientId] = 100; });
            // assign blinds indices if not present: creator as small blind, next as big blind
            if (typeof game.smallBlindIndex !== 'number'){
                const creatorIndex = (game.clients || []).findIndex(x => x.clientId === game.creator);
                game.smallBlindIndex = creatorIndex >= 0 ? creatorIndex : 0;
            }
            if (typeof game.bigBlindIndex !== 'number'){
                const n = (game.clients || []).length || 1;
                game.bigBlindIndex = (game.smallBlindIndex + 1) % n;
            }
            // place blinds immediately for round 1
            if (game.round === 1){
                const sbIdx = game.smallBlindIndex;
                const bbIdx = game.bigBlindIndex;
                const sbPlayer = (game.clients || [])[sbIdx];
                const bbPlayer = (game.clients || [])[bbIdx];
                const smallAmt = 2;
                const bigAmt = 5;
                // ensure amountsAdded entries
                if (sbPlayer && sbPlayer.clientId){ amountsAdded[sbPlayer.clientId] = amountsAdded[sbPlayer.clientId] || 0; }
                if (bbPlayer && bbPlayer.clientId){ amountsAdded[bbPlayer.clientId] = amountsAdded[bbPlayer.clientId] || 0; }
                // deduct from chips and add to pot
                if (sbPlayer && sbPlayer.clientId){
                    const id = sbPlayer.clientId;
                    const avail = (game.chips && typeof game.chips[id] === 'number') ? game.chips[id] : 0;
                    const put = Math.min(avail, smallAmt);
                    game.chips[id] = Math.max(0, avail - put);
                    amountsAdded[id] = (amountsAdded[id] || 0) + put;
                    game.pot = (typeof game.pot === 'number' ? game.pot : 0) + put;
                    pushGameMessage(game, (sbPlayer.name || id) + ' posts small blind of ' + put + ' chips');
                }
                if (bbPlayer && bbPlayer.clientId){
                    const id = bbPlayer.clientId;
                    const avail = (game.chips && typeof game.chips[id] === 'number') ? game.chips[id] : 0;
                    const put = Math.min(avail, bigAmt);
                    game.chips[id] = Math.max(0, avail - put);
                    amountsAdded[id] = (amountsAdded[id] || 0) + put;
                    game.pot = (typeof game.pot === 'number' ? game.pot : 0) + put;
                    pushGameMessage(game, (bbPlayer.name || id) + ' posts big blind of ' + put + ' chips');
                }
                // update game.max to reflect highest posted blind
                const postedMax = Math.max(
                    (sbPlayer && amountsAdded[sbPlayer.clientId]) || 0,
                    (bbPlayer && amountsAdded[bbPlayer.clientId]) || 0,
                    game.max || 0
                );
                game.max = postedMax;
                game.value = game.pot;
            }
            game.deck = deck; // remaining deck for community
            game.community = [];

            // include current turn username for UI
            enrichGame(game);
            // announce start
            pushGameMessage(game, 'game started');

            // send start to each client, embedding that client's private hand
            (game.clients || []).forEach(c => {
                const con = clients[c.clientId] && clients[c.clientId].connection;
                if (!con) return;
                const personalPayload = Object.assign({}, payLoad);
                personalPayload.privateHand = game.privateHands[c.clientId] || [];
                con.send(JSON.stringify(personalPayload));
            });
        }

        // fold action
        if (result.method === 'fold'){
            const clientId = result.clientId;
            const gameId = result.gameId;
            const game = games[gameId];
            if (!game) return;
            // mark player as folded
            for (let i=0;i<game.clients.length;i++){
                if (game.clients[i].clientId === clientId){
                    game.clients[i].folded = true;
                    const pName = game.clients[i].name || clientId;
                    pushGameMessage(game, pName + ' folded');
                    break;
                }
            }
            // broadcast update
            const payLoad = { method: 'update', game: game, gameId };
            enrichGame(game);
            game.clients.forEach(c => {
                clients[c.clientId].connection.send(JSON.stringify(payLoad))
            })
            // check if only one player remains (everyone else folded) -> award pot
            try {
                const activePlayers = (game.clients || []).filter(p => !p.folded);
                if (activePlayers.length === 1) {
                    const winner = activePlayers[0];
                    const winnerId = winner.clientId;
                    const winnerName = winner.name || winnerId;
                    const potAmount = typeof game.pot === 'number' ? game.pot : 0;
                    if (!game.chips) game.chips = {};
                    game.chips[winnerId] = (typeof game.chips[winnerId] === 'number' ? game.chips[winnerId] : 0) + potAmount;
                    // announce winner and clear pot
                    pushGameMessage(game, winnerName + ' wins the pot of ' + potAmount + ' chips');
                    game.pot = 0;
                    game.value = 0;
                    // broadcast final update showing winner and updated chips
                    const finalPayload = { method: 'update', game: game, gameId };
                    enrichGame(game);
                    game.clients.forEach(c => {
                        if (clients[c.clientId] && clients[c.clientId].connection) clients[c.clientId].connection.send(JSON.stringify(finalPayload));
                    });
                    // end and schedule restart
                    game.ended = true;
                    game.started = false;
                    scheduleRestartIfNeeded(game.id);
                }
            } catch (e) {
                console.error('Error during fold-win check', e);
            }
        }
    })

    //generate a new clientId
    const clientId = guid();
    clients[clientId] = {
        "connection":  connection
    }

    const payLoad = {
        "method": "connect",
        "clientId": clientId
    }
    //send back the client connect
    connection.send(JSON.stringify(payLoad))

})


function updateGameState(){

    //{"gameid", fasdfsf}
    for (const g of Object.keys(games)) {
        const game = games[g]
        const payLoad = {
            "method": "update",
            "game": game
        }

        // enrich game with derived fields before broadcasting
        enrichGame(game);
        game.clients.forEach(c=> {
            clients[c.clientId].connection.send(JSON.stringify(payLoad))
        })
    }

    setTimeout(updateGameState, 500);
}



function S4() {
    return (((1+Math.random())*0x10000)|0).toString(16).substring(1); 
}
 
// then to call it, plus stitch in '4' in the third group
const guid = () => (S4() + S4() + "-" + S4() + "-4" + S4().substr(0,3) + "-" + S4() + "-" + S4() + S4() + S4()).toLowerCase();
const guid1 = () => S4();

// schedule a restart once when a game ends
function scheduleRestartIfNeeded(gameId){
    const game = games[gameId];
    if (!game) return;
    if (game._restartScheduled) return;
    game._restartScheduled = true;
    // give clients a moment to see final state/messages
    setTimeout(()=>{
        // ensure game still exists and is ended
        const g = games[gameId];
        if (!g) return;
        if (!g.ended) { g._restartScheduled = false; return; }
        restartGame(gameId);
    }, 3000);
}

// restart a game: reset per-round state, un-fold players, deal new hands and start
function restartGame(gameId){
    const game = games[gameId];
    if (!game) return;
    // clear flags
    game.ended = false;
    game.started = true;
    game.round = 1;
    game.turnIndex = 0;
    game.pot = 0;
    game.value = 0;
    game.max = 0;
    game.roundended = false;
    game.nextroundpurity = 0;
    // reset per-client added amounts and folded flags
    if (Array.isArray(game.clients)){
        game.clients.forEach(c => {
            if (c) c.folded = false;
            if (c && c.clientId) amountsAdded[c.clientId] = 0;
        })
    }
    // advance blind positions (cycle one up)
    if (Array.isArray(game.clients) && game.clients.length > 0){
        const n = game.clients.length;
        game.smallBlindIndex = (typeof game.smallBlindIndex === 'number') ? (game.smallBlindIndex + 1) % n : 0;
        game.bigBlindIndex = (typeof game.bigBlindIndex === 'number') ? (game.smallBlindIndex + 1) % n : (n > 1 ? 1 : 0);
    }
    // prepare a new deck and deal private hands
    const suits = ['S','H','D','C'];
    const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    let deck = [];
    suits.forEach(s => ranks.forEach(r => deck.push(r + s)));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    game.privateHands = {};
    (game.clients || []).forEach(c => {
        const card1 = deck.pop();
        const card2 = deck.pop();
        game.privateHands[c.clientId] = [card1, card2];
    });
    game.deck = deck;
    game.community = [];
    // preserve chips across restarts: don't reset `game.chips` here
    // place blinds for the new game (round 1)
    if (Array.isArray(game.clients) && game.clients.length > 0){
        const sbIdx = game.smallBlindIndex || 0;
        const bbIdx = game.bigBlindIndex || ((sbIdx + 1) % game.clients.length);
        const sbPlayer = game.clients[sbIdx];
        const bbPlayer = game.clients[bbIdx];
        const smallAmt = 2;
        const bigAmt = 5;
        if (sbPlayer && sbPlayer.clientId){ amountsAdded[sbPlayer.clientId] = amountsAdded[sbPlayer.clientId] || 0; }
        if (bbPlayer && bbPlayer.clientId){ amountsAdded[bbPlayer.clientId] = amountsAdded[bbPlayer.clientId] || 0; }
        if (sbPlayer && sbPlayer.clientId){
            const id = sbPlayer.clientId;
            const avail = (game.chips && typeof game.chips[id] === 'number') ? game.chips[id] : 0;
            const put = Math.min(avail, smallAmt);
            game.chips[id] = Math.max(0, avail - put);
            amountsAdded[id] = (amountsAdded[id] || 0) + put;
            game.pot = (typeof game.pot === 'number' ? game.pot : 0) + put;
            pushGameMessage(game, (sbPlayer.name || id) + ' posts small blind of ' + put + ' chips');
        }
        if (bbPlayer && bbPlayer.clientId){
            const id = bbPlayer.clientId;
            const avail = (game.chips && typeof game.chips[id] === 'number') ? game.chips[id] : 0;
            const put = Math.min(avail, bigAmt);
            game.chips[id] = Math.max(0, avail - put);
            amountsAdded[id] = (amountsAdded[id] || 0) + put;
            game.pot = (typeof game.pot === 'number' ? game.pot : 0) + put;
            pushGameMessage(game, (bbPlayer.name || id) + ' posts big blind of ' + put + ' chips');
        }
        const postedMax = Math.max(...(game.clients.map(c => (c && c.clientId) ? (amountsAdded[c.clientId] || 0) : 0)), game.max || 0);
        game.max = postedMax;
        game.value = game.pot;
    }
    // announce restart
    pushGameMessage(game, 'new game starting');
    // send a start payload to each client with their private hand
    const payLoad = { method: 'start', game: game, gameId };
    enrichGame(game);
    (game.clients || []).forEach(c => {
        const con = clients[c.clientId] && clients[c.clientId].connection;
        if (!con) return;
        const personalPayload = Object.assign({}, payLoad);
        personalPayload.privateHand = game.privateHands[c.clientId] || [];
        con.send(JSON.stringify(personalPayload));
    });
    // clear restart flag
    game._restartScheduled = false;
}

// add derived fields to a game object before sending to clients
function enrichGame(game){
    if (!game) return game;
    // ensure round exists
    game.round = typeof game.round === 'number' ? game.round : 0;
    // determine current turn username strictly by client 'name'
    let name = null;
    if (Array.isArray(game.clients) && typeof game.turnIndex === 'number'){
        const p = game.clients[game.turnIndex];
        if (p && typeof p.name === 'string') name = p.name;
    }
    game.currentTurnName = name;
    // attach per-client added amounts so clients can show how much they've added
    game.amountsAdded = {};
    if (Array.isArray(game.clients)){
        game.clients.forEach(c => {
            game.amountsAdded[c.clientId] = (typeof amountsAdded[c.clientId] === 'number') ? amountsAdded[c.clientId] : 0;
        })
    }
    // ensure chips mapping exists so clients can display balances
    // ensure chips mapping exists so clients can display balances (do not populate per-player values here)
    game.chips = game.chips || {};
    // ensure messages array exists so chat/history can be shown to clients
    game.messages = Array.isArray(game.messages) ? game.messages : [];
    return game;
}

// helper to push a chat/message entry onto a game's messages array
function pushGameMessage(game, text){
    if (!game) return;
    game.messages = Array.isArray(game.messages) ? game.messages : [];
    const now = new Date().toISOString();
    game.messages.push({ text, time: now });
}

// ----- Poker hand evaluation helpers -----
function rankValue(r){
    if (r === 'A') return 14;
    if (r === 'K') return 13;
    if (r === 'Q') return 12;
    if (r === 'J') return 11;
    return parseInt(r,10);
}

function parseCard(code){
    if (!code) return null;
    const suit = code.slice(-1).toUpperCase();
    const rank = code.slice(0, -1).toUpperCase();
    return { r: rankValue(rank), s: suit };
}

function compareArrays(a,b){
    for (let i=0;i<Math.max(a.length,b.length);i++){
        const av = a[i]||0; const bv = b[i]||0;
        if (av>bv) return 1;
        if (av<bv) return -1;
    }
    return 0;
}

function compareScores(a,b){
    // both are arrays [category, ...tiebreakers]
    if (!a) return -1;
    if (!b) return 1;
    if (a[0] > b[0]) return 1;
    if (a[0] < b[0]) return -1;
    return compareArrays(a.slice(1), b.slice(1));
}

function bestHandScore(allCards){
    // allCards: array of codes like 'AS'
    const parsed = (allCards || []).map(parseCard).filter(Boolean);
    if (parsed.length < 5) return [0];
    const combos = kCombinations(parsed,5);
    let best = null;
    combos.forEach(c5 => {
        const sc = scoreFive(c5);
        if (!best || compareScores(sc,best) > 0) best = sc;
    })
    return best || [0];
}

function kCombinations(arr, k){
    const results = [];
    function helper(start, combo){
        if (combo.length === k){ results.push(combo.slice()); return; }
        for (let i=start;i<arr.length;i++){ combo.push(arr[i]); helper(i+1, combo); combo.pop(); }
    }
    helper(0,[]);
    return results;
}

function scoreFive(cards){
    // cards: array of 5 {r,s}
    const ranks = cards.map(c=>c.r).sort((a,b)=>b-a);
    const suits = {};
    const counts = {};
    ranks.forEach(r => { counts[r] = (counts[r]||0)+1; });
    cards.forEach(c => { suits[c.s] = (suits[c.s]||0)+1; });
    const isFlush = Object.keys(suits).some(s => suits[s]===5);
    // straight detection (handle A as 1)
    const uniq = Array.from(new Set(ranks)).sort((a,b)=>b-a);
    let isStraight = false; let highStraight = 0;
    if (uniq.length >=5){
        // check normal
        for (let i=0;i<=uniq.length-5;i++){
            const seq = uniq.slice(i,i+5);
            if (seq[0]-seq[4]===4 && seq.length===5){ isStraight=true; highStraight=seq[0]; break; }
        }
        // check wheel A-5
        if (!isStraight){
            const hasA = uniq.includes(14);
            const wheel = [5,4,3,2,14];
            if (wheel.every(v=>uniq.includes(v))){ isStraight=true; highStraight=5; }
        }
    }
    // counts
    const countVals = Object.keys(counts).map(r=>({r:parseInt(r,10),c:counts[r]})).sort((a,b)=>{ if (b.c!==a.c) return b.c-a.c; return b.r-a.r; });
    // four of a kind
    if (countVals[0].c === 4){
        const quad = countVals[0].r;
        const kicker = countVals[1].r;
        return [8, quad, kicker]; // category 8 for four
    }
    // full house
    if (countVals[0].c === 3 && countVals[1] && countVals[1].c >=2){
        return [7, countVals[0].r, countVals[1].r];
    }
    // flush
    if (isFlush && isStraight){
        return [9, highStraight]; // straight flush (category 9 highest)
    }
    if (isFlush){
        return [6].concat(ranks);
    }
    if (isStraight){
        return [5, highStraight];
    }
    if (countVals[0].c === 3){
        // trips
        const trips = countVals[0].r;
        const kickers = countVals.slice(1).map(x=>x.r).sort((a,b)=>b-a);
        return [4, trips].concat(kickers);
    }
    if (countVals[0].c === 2 && countVals[1] && countVals[1].c === 2){
        // two pair
        const highPair = Math.max(countVals[0].r, countVals[1].r);
        const lowPair = Math.min(countVals[0].r, countVals[1].r);
        const kicker = countVals.find(x=>x.c===1).r;
        return [3, highPair, lowPair, kicker];
    }
    if (countVals[0].c === 2){
        const pair = countVals[0].r;
        const kickers = countVals.slice(1).map(x=>x.r).sort((a,b)=>b-a);
        return [2, pair].concat(kickers);
    }
    // high card
    return [1].concat(ranks);
}
