/* Copyright (c) Facebook, Inc. and its affiliates.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

// TODO add some testing to launch this server and communicate with it

const bodyParser = require('body-parser');
const express = require('express');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const multer  = require('multer');

const task_directory_name = 'static';

const PORT = process.env.PORT || 3000;

// Generate a random id
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Initialize app
const app = express();
app.use(bodyParser.text());
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);
app.use(bodyParser.json());

let upload  = multer({ storage: multer.memoryStorage() });

const server = http.createServer(app);

// ======= <Sockets and Agents> ========

// TODO can we pull all these from somewhere, make sure they're testable
// and show they're the same as the python ones?
const STATUS_INIT = 'init'
const STATUS_CONNECTED = 'connected'
const STATUS_DISCONNECTED = 'disconnect'
const STATUS_DONE = 'done'

const SYSTEM_SOCKET_ID = 'mephisto'  // TODO pull from somewhere
// TODO use registered socket id from on_alive
const SERVER_SOCKET_ID = 'mephisto_server'

const PACKET_TYPE_REQUEST_AGENT_STATUS = 'request_status'
const PACKET_TYPE_RETURN_AGENT_STATUS = 'return_status'
const PACKET_TYPE_INIT_DATA = 'initial_data_send'
const PACKET_TYPE_AGENT_ACTION = 'agent_action'
const PACKET_TYPE_NEW_AGENT = 'register_agent'
const PACKET_TYPE_NEW_WORKER = 'register_worker'
const PACKET_TYPE_GET_INIT_DATA = 'init_data_request'
const PACKET_TYPE_ALIVE = 'alive'
const PACKET_TYPE_PROVIDER_DETAILS = 'provider_details'
const PACKET_TYPE_SUBMIT_ONBOARDING = 'submit_onboarding'

// State for agents tracked by the server
class LocalAgentState {
  constructor(agent_id) {
    this.status = STATUS_INIT;
    this.agent_id = agent_id;
    this.unsent_messages = [];
  }

  get_sendable_messages() {
    let sendable_messages = this.unsent_messages;
    this.unsent_messages = []
    return sendable_messages;
  }
}

const wss = new WebSocket.Server({ server });

// Track connectionss
var agent_id_to_socket = {};
var socket_id_to_agent = {};
var mephisto_message_queue = [];
var main_thread_timeout = null;
var mephisto_socket = null;

// This is a mapping of connection id -> state
var agent_id_to_agent = {};

var pending_provider_requests = {};
var pending_init_requests = {};


// Handles sending a message through the socket
function _send_message(socket, packet) {
  if (!socket) {
    // Socket doesn't exist - odd
    return;
  }

  if (socket.readyState == 3) {
    // Socket has already closed
    return;
  }

  console.log(packet);

  // Send the message through, with one retry a half second later
  socket.send(JSON.stringify(packet), function ack(error) {
    if (error === undefined) {
      return;
    }
    setTimeout(function() {
      socket.send(JSON.stringify(packet), function ack2(error2) {
        if (error2 === undefined) {
          return;
        } else {
          console.log(error2);
        }
      });
    }, 500);
  });
}

// Open connections send alives to identify who they are,
// register them correctly here
function handle_alive(socket, alive_packet) {
  if (alive_packet.sender_id == SYSTEM_SOCKET_ID) {
    mephisto_socket = socket;
    if (main_thread_timeout === null) {
      console.log('launching main thread')
      main_thread_timeout = setTimeout(main_thread, 50);
    }
  } else {
    var agent_id = alive_packet['sender_id']
    var agent = LocalAgentState(agent_id);
    agent_id_to_socket[agent_id] = socket;
    socket_id_to_agent[socket.id] = agent;
    agent_id_to_agent[agent_id] = agent;
  }
}

// Return the status of all agents mapped by their agent id
function handle_get_agent_status(status_packet) {
  let agent_statuses = {};
  for (let agent_id in agent_id_to_agent) {
    agent_statuses[agent_id] = agent_id_to_agent[agent_id].status;
  }
  let packet = {
    packet_type: PACKET_TYPE_RETURN_AGENT_STATUS,
    sender_id: SERVER_SOCKET_ID,
    receiver_id: SYSTEM_SOCKET_ID,
    data: agent_statuses,
  };
  mephisto_message_queue.push(packet);
}

// Handle a message being sent to or from a frontend agent
function handle_forward(packet) {
  if (alive_packet.receiver_id == SYSTEM_SOCKET_ID) {
    mephisto_message_queue.push(packet);
  } else {
    let agent = agent_id_to_agent[packet.receiver_id];
    agent.unsent_messages.push(packet);
  }
}

// Register handlers
wss.on('connection', function(socket) {
  console.log('Client connected');
  // Disconnects are logged
  socket.on('disconnect', function() {
    console.log('disconnected')
    var agent = socket_id_to_agent[socket.id];
    if (agent !== undefined) {
      // TODO set a timeout to see if the agent reconnects,
      // or consider them disconnected or if they've already
      // completed the task
    }
  });

  socket.on('error', err => {
    console.log('Caught socket error');
    console.log(err);
  });

  // handles routing a packet to the desired recipient
  socket.on('message', function(packet) {
    try {
      packet = JSON.parse(packet);
      console.log(packet);
      if (packet['packet_type'] == PACKET_TYPE_REQUEST_AGENT_STATUS) {
        handle_get_agent_status(packet);
      } else if (packet['packet_type'] == PACKET_TYPE_AGENT_ACTION) {
        handle_forward(packet);
      } else if (packet['packet_type'] == PACKET_TYPE_ALIVE) {
        handle_alive(socket, packet);
      } else if (
        packet['packet_type'] == PACKET_TYPE_PROVIDER_DETAILS ||
        packet['packet_type'] == PACKET_TYPE_INIT_DATA
      ) {
        let request_id = packet['data']['request_id']
        if (request_id === undefined) {
          request_id = packet['receiver_id']
        }
        let res_obj = pending_provider_requests[request_id]
        res_obj.json(packet);
        delete pending_provider_requests[request_id]
      }
    } catch (error) {
      console.log('Transient error on message');
      console.log(error);
    }
  });
});

server.listen(PORT, function() {
  console.log('Listening on %d', server.address().port);
});

// ============ </Sockets and Agents> ==============

// ======================= <Threads> =======================

// TODO add crash checking around this thread?
function main_thread() {
  // Handle active connections message sends
  for (const agent_id in agent_id_to_socket) {
    let agent_state = agent_id_to_agent[agent_id];
    let sendable_messages = agent_state.get_sendable_messages();
    if (sendable_messages.length > 0) {
      let socket = agent_id_to_socket[agent_id];
      // TODO send all these messages in a batch
      for (const packet of sendable_messages) {
        _send_message(socket, packet);
      }
    }
  }

  // Handle sending batches to the mephisto python client
  let mephisto_messages = []
  while (mephisto_message_queue.length > 0) {
    mephisto_messages.push(mephisto_message_queue.shift());
  }
  if (mephisto_messages.length > 0) {
    for (const packet of mephisto_messages) {
      _send_message(mephisto_socket, packet);
    }
  }

  // Re-call this thead, as it should run forever
  main_thread_timeout = setTimeout(main_thread, 50);
}

// ======================= </Threads> ======================

// ===================== <Routing> ========================
function make_provider_request(request_type, provider_data, res) {
  var request_id = uuidv4();

  let request_packet = {
    packet_type: request_type,
    sender_id: SERVER_SOCKET_ID,
    receiver_id: SYSTEM_SOCKET_ID,
    data: {
      'provider_data': provider_data,
      'request_id': request_id,
    },
  };

  pending_provider_requests[request_id] = res;
  _send_message(mephisto_socket, request_packet);
  // TODO set a timeout to expire this request rather than leave the worker hanging
}

app.post('/initial_task_data', function(req, res) {
  var provider_data = req.body.provider_data;
  make_provider_request(PACKET_TYPE_GET_INIT_DATA, provider_data, res);
});

app.post('/register_worker', function(req, res) {
  var provider_data = req.body.provider_data;
  make_provider_request(PACKET_TYPE_NEW_WORKER, provider_data, res);
});

app.post('/request_agent', function(req, res) {
  var provider_data = req.body.provider_data;
  make_provider_request(PACKET_TYPE_NEW_AGENT, provider_data, res);
});

app.post('/submit_onboarding', function(req, res) {
  var provider_data = req.body.provider_data;
  make_provider_request(PACKET_TYPE_SUBMIT_ONBOARDING, provider_data, res);
});

app.post('/submit_task', upload.any(), function(req, res) {
  var provider_data = req.body;
  let agent_id = provider_data.USED_AGENT_ID;
  delete provider_data.USED_AGENT_ID;
  let submit_packet = {
    packet_type: PACKET_TYPE_AGENT_ACTION,
    sender_id: agent_id,
    receiver_id: SYSTEM_SOCKET_ID,
    data: {
      'task_data': provider_data,
      'is_submit': true,
      'files': req.files,
    },
  };
  _send_message(mephisto_socket, submit_packet);
  res.json({status: 'Submitted!'})
});

// Quick status check for this server
app.get('/is_alive', function(req, res) {
  res.json({status: 'Alive!'});
});

// Returns server time for now
app.get('/get_timestamp', function(req, res) {
  res.json({ timestamp: Date.now() }); // in milliseconds
});

app.get('/task_index', function(req, res) {
  // TODO how do we pass the task config to the frontend?
  res.render('index.html');
});

app.use(express.static('static'));

// ======================= </Routing> =======================
