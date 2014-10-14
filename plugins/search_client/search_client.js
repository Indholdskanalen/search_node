/**
 * @file
 * Handles communication between the client (socket.io) and search.
 */

/**
 * Register the plugin with architect.
 */
module.exports = function (options, imports, register) {
  "use strict";

  // Get socket.
  var sio = imports.socket;

  // Get log.
  var logger = imports.logger;

  // New connection is made via sockets.
  sio.on('connection', function (socket) {
    // Log that connection was made.
    logger.info('Client have made connection: ' + socket.id);

    /**
     * Handle search message.
     */
    socket.on('search', function(data) {

      // @TODO: Check that customer_id and type exists in the data.
      // Create new search instance.
      var instance = new imports.search(data.customer_id, data.type);

      // Handle completed query.
      instance.once('hits', function (hits) {
        // Send data back.
        socket.emit('result', hits);
      });

      // Handle errors in the search.
      instance.once('error', function (data) {
        logger.error(data);
      });

      // Remove customer ID and type.
      // @todo: finder better way to get customer id, store it in socket
      // connection.
      delete data.customer_id;
      delete data.type;

      // Send the query.
      instance.query(data);
    });
  });

  // This plugin extends the socket plugin and do not provide new services.
  register(null, null);
};
