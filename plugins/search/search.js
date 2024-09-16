/**
 * @file
 * Handles communication with the search backend.
 */

// Node core modules required.
var util = require('util');
var eventEmitter = require('events').EventEmitter;

// Modules used to and by the search backend.
var elasticsearch = require('elasticsearch');
var rename = require('rename-keys');
var merge = require('merge-light');

// Register the plugin.
module.exports = function (options, imports, register) {
  "use strict";

  /**
   * Build field mappings for a single field in the index.
   *
   * @param map
   *   Mapping information for the field from mappings.json.
   * @param body
   *   The index body json object.
   */
  function buildIndexMapping(map, body) {
    var field = {};

    // Check if field should be indexed/searchable.
    if (map.hasOwnProperty('geopoint') && map.geopoint === true) {
      field["field_" + map.field] = {
        "match": map.field,
        "mapping": {
          "type": map.type,
          "lat_lon": true
        }
      };
    }
    else if (map.hasOwnProperty('indexable') && map.indexable === false) {
      // Disable analyse and indexing this field.
      field["field_" + map.field] = {
        "match": map.field,
        "match_mapping_type": map.type,
        "mapping": {
          "type": map.type,
          "index": 'no'
        }
      };
    }
    else {
      field["field_" + map.field] = {
        "match": map.field,
        "match_mapping_type": map.type,
        "mapping": {
          "type": map.type
        }
      };

      if (map.hasOwnProperty('default_indexer') && map.default_indexer !== '') {
        field["field_" + map.field].mapping.index = map.default_indexer;
      }

      // Add field default analyzer (eg. ngram string indexer).
      if (map.hasOwnProperty('default_analyzer') && map.default_analyzer !== '') {
        field["field_" + map.field].mapping.analyzer = map.default_analyzer;
      }
      else {
        field["field_" + map.field].mapping.analyzer = 'string_index';
      }

      // Set filter language.
      if (map.hasOwnProperty('language') && map.hasOwnProperty('country')) {
        // @TODO: more language support (https://www.elastic.co/guide/en/elasticsearch/reference/1.7/analysis-stemmer-tokenfilter.html).
        if (map.language === 'da') {
          body.settings.analysis.filter.stemmer_language.name = 'danish';
        }
      }

      var analyzer = 'ducet_sort';
      // If language and country is defined, create new filter
      if (map.hasOwnProperty('language') && map.hasOwnProperty('country')) {
        // Update language in filter.
        body.settings.analysis.filter.search_language.language = map.language;
        body.settings.analysis.filter.search_language.country = map.country;

        // Change analyzer to use language sort.
        analyzer = 'language_sort';
      }

      // Add sort field if required as an analyzer not filter as above.
      if (map.hasOwnProperty('sort') && map.sort) {
        field["field_" + map.field].mapping.fields = {
          "sort": {
            "type":  map.type,
            "analyzer": analyzer
          }
        };
      }

      // Add raw field to use as filtering/facets.
      if (map.hasOwnProperty('raw') && map.raw) {
        field["field_" + map.field].mapping.fields = {
          "raw": {
            "type":  map.type,
            "index": "not_analyzed"
          }
        };
      }
    }

    // Add the new field to templates.
    body.mappings._default_.dynamic_templates.push(field);
  }

  /**
   * Helper function to create default mappings if they do not exists.
   *
   * @param body
   *   The body element to sent to the search engine when build a new index.
   */
  function addDefaultMapping(body) {
    // Check if mapping exists.
    if (!body.hasOwnProperty('mappings')) {
      // Add mappings.
      body.mappings = {
        "_default_": {
          "date_detection": false,
          "dynamic_templates": []
        }
      };
    }
  }

  /**
   * Build new index in the search backend.
   *
   * @param self
   *   Reference to the current search object.
   * @param logger
   *   Reference to logger object.
   * @param map
   *   Mapping information for the index.
   * @param index
   *   The index to build.
   */
  function buildNewIndex(self, logger, map, index) {
    var body = {
      "settings": {
        "analysis": {
          "analyzer": {
            "string_search" : {
              "tokenizer" : "standard",
              "filter" : ["lowercase", "stemmer_language"]
            },
            "string_index": {
              "tokenizer": "standard",
              "filter": [ "lowercase", "ngram" ]
            },
            "ducet_sort": {
              "tokenizer": "keyword",
              "filter": [ "icu_collation" ]
            },
            "language_sort": {
              "tokenizer": "keyword",
              "filter": [ "search_language" ]
            },
            "analyzer_startswith": {
              "tokenizer": "keyword",
              "filter": [ "lowercase", "no_stop" ]
            }
          },
          "tokenizer" : {
            "alpha_nummeric_only": {
              "pattern": "[^\\p{L}\\d]+",
              "type": "pattern"
            }
          },
          "filter": {
            "ngram": {
              "type": "nGram",
              "min_gram": 1,
              "max_gram": 28,
              "token_chars": [ "letter", "digit" ]
            },
            "stemmer_language": {
              "type" : "stemmer",
              "name" : "english"
            },
            "no_stop": {
              "type":       "stop",
              "stopwords":  "_none_"
            },
            "search_language": {
              "type": "icu_collation",
              "language": "en",
              "country":  "UK"
            }
          }
        }
      }
    };

    // Setup dynamic mappings for language and sorting.
    if (map.hasOwnProperty('fields')) {
      addDefaultMapping(body);

      // Loop over field and add them.
      for (var i in map.fields) {
        buildIndexMapping(map.fields[i], body);
      }
    }

    // Setup mappings for dates.
    if (map.hasOwnProperty('dates')) {
      addDefaultMapping(body);

      // Add dates mappings.
      body.mappings._default_.dynamic_templates.push({
        "dates": {
          "match": map.dates.join('|'),
          "match_pattern": 'regex',
          "mapping": {
            "type": 'date'
          }
        }
      });
    }

    // Create the index.
    self.es.indices.create({
      "index": index,
      "body": body
    }, function (err, response, status) {
      if (status === 200) {
        logger.info('New index have been created: ' + index);
        self.emit('indexCreated', index);
      }
      else {
        console.log(response);
        self.emit('error', { 'status': status, 'res': response });
      }
    });
  }

  /**
   * Add content/document to the search backend.
   *
   * @param self
   *   Reference to the current search object.
   * @param index
   *   The index to use.
   * @param type
   *   Type of the index.
   * @param body
   *   The document to add.
   * @param id
   *   The documents unique id.
   */
  function addContent(self, index, type, body, id) {
    self.es.index({
      "index": index,
      "type": type,
      "id": id,
      "body": body
    }, function (err, response, status) {
      if (status === 201) {
        // Status "201" is created.
        self.emit('created', { 'status': status, 'index': index });
      }
      else if (status === 200) {
        // Status "200" is updated.
        self.emit('updated', { 'status': status, 'index': index })
      }
      else {
        if (status === undefined) {
          status = 500;
          response = {
            "message": err
          };
        }

        self.emit('error', { 'status': status, 'res' : response});
      }
    });
  }

  /**
   * Append ".sort" to a string.
   *
   * Used in the query build to ensure that the sort field is used to sort on
   * based on the mappings loaded.
   *
   * @param property
   *
   * @returns {string}
   */
  function addSort(property) {
    return property + '.sort';
  }

  /*********************
   * The Search object
   *********************/

  /**
   * Define the Search object (constructor).
   *
   * @param index
   *   The unique id to identify the index to use.
   * @param type !optional
   *   The type of documents to search or manipulate.
   * @param id !optional
   *   The documents unique id.
   */
  var Search = function Search(index, type, id) {
    // Set internal variables.
    this.index = index;
    this.type = type;
    this.id = id;

    // Connection to Elasticsearch. For more information about the settings
    // available see: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/configuration.html
    // Pull in the explicit configuration of the ES host.
    var hosts = {'hosts': JSON.parse(JSON.stringify(options.hosts))};
    var settings = JSON.parse(JSON.stringify(options.settings));
    var conf = merge({hosts: hosts}, settings);
    console.log(conf);
    this.es = elasticsearch.Client(conf);

    // Set logger for the object (other plugin).
    this.logger = imports.logger;

    // Set mapping (other plugin).
    this.mappings = imports.mappings;
  };

  // Extend the object with event emitter.
  util.inherits(Search, eventEmitter);

  /**
   * Add content to the search backend.
   *
   * @param body
   *
   * @TODO: explain the data format { ???? }.
   */
  Search.prototype.add = function add(body) {
    var self = this;

    // Log request to the debugger.
    self.logger.debug('Search: Add request for: ' + self.index + ' with type: ' + self.type);

    self.es.indices.exists({
      "index": self.index
    }, function (err, response, status) {
      if (status === 404) {
        self.logger.error('Search: Add request for unknown index: ' + self.index + ' with type: ' + self.type);
      }
      else {
        // Index and mapping exists, so just add the document.
        addContent(self, self.index, self.type, body, self.id);
      }
    });
  };

  /**
   * Update content to the search backend.
   *
   * @param doc
   *   The data to update in the index.
   *
   * @TODO: explain the data format.
   */
  Search.prototype.update = function update(doc) {
    var self = this;

    // Simply call the add function as it will update the document.
    self.add(doc);
  };

  /**
   * Remove document from the backend.
   */
  Search.prototype.remove = function remove() {
    var self = this;

    // Log request to the debugger.
    self.logger.debug('Search: Remove request from: ' + self.index + ' with type: ' + self.type + ' and id:' + self.id);

    // Remove content.
    self.es.delete({
      "index": self.index,
      "type": self.type,
      "id": self.id
    }, function (err, response, status) {
      if (status === 200) {
        self.emit('removed', { 'id' : self.id });
      }
      else {
        self.emit('error', { 'id' : self.id, 'status': status, 'res' : response});
      }
    });
  };

  /**
   * Preform search query against the search engine.
   *
   * @param data
   *   The data that should be queried base on.
   */
  Search.prototype.query = function query(data) {
    var self = this;

    // Log request to the debugger.
    self.logger.info('Search: Query request in: ' + self.index + ' with type: ' + self.type);

    self.mappings.get(self.index).then(
      function (map) {
        // Use mappings to fix sort on strings.
        if (data.hasOwnProperty('sort')) {
          for (var i in map.fields) {
            if (data.sort.hasOwnProperty(map.fields[i].field)) {
              // Rename the property by adding .sort to switch sorting to using the fully
              // indexed string for the field.
              data.sort = rename(data.sort, addSort);
            }
          }
        }

        // Add the sort search query.
        var search_query = {
          "type": self.type,
          "index": self.index,
          "body": data
        };

        /**
         * @TODO: Validate the search JSON request for safety reasons.
         */

        // Execute the search.
        self.es.search(search_query).then(function (resp) {
          var hits = [];
          var aggregations = [];
          if (resp.hits.total > 0) {
            // We got hits, return only _source.
            for (var hit in resp.hits.hits) {
              var result = resp.hits.hits[hit]._source;
              result._id = resp.hits.hits[hit]._id;
              result._score = resp.hits.hits[hit]._score;

              // Include highlight information is available.
              if (resp.hits.hits[hit].hasOwnProperty('highlight')) {
                result._highlight = resp.hits.hits[hit].highlight;
              }

              hits.push(result);
            }

            // Get aggregations.
            if (resp.hasOwnProperty('aggregations')) {
              aggregations = resp.aggregations;
            }

            // Log number of hits found.
            self.logger.debug('Search: hits found: ' + resp.hits.total + ' items for ' + self.index + ' with type: ' + self.type);
          }

          // Emit hits.
          self.emit('hits', {
            'hits': resp.hits.total,
            'results': hits,
            'aggs': aggregations
          });
        },
        function (error) {
          self.emit('error', { message: error.message });
        });
      },
      function (error) {
        self.emit('error', { message: error.message });
      }
    );
  };

  /**
   * Preform count query against the search engine.
   *
   * @param data
   *   The data that should be queried base on.
   */
  Search.prototype.count = function count(data) {
    var self = this;

    // Log request to the debugger.
    self.logger.info('Search: Count query request in: ' + self.index + ' with type: ' + self.type);

    // Add the sort search query.
    var search_query = {
      "searchType": 'count',
      "type": self.type,
      "index": self.index,
      "body": data
    };

    // Execute the search count query.
    self.es.search(search_query).then(function (resp) {
      // Emit counts (aggregations).
      self.emit('counts', resp.aggregations);
    },
    function (error) {
      self.emit('error', { message: error.message });
    });
  };

  /**
   * Get indexes available on the server.
   */
  Search.prototype.getIndexes = function getIndexes() {
    var self = this;

    self.es.cat.indices(function (err, response, status) {
      if (status === 200) {
        var indexes = {};
        if (response !== undefined) {
          var lines = response.split(/\n/g);
          for (var i in lines) {
            var parts = lines[i].match(/[\w\.\d]+/g);
            if (parts !== null) {
              indexes[parts[2]] = {
                "health": parts[0],
                "open": parts[1],
                "index": parts[2],
                "pri": parts[3],
                "rep": parts[4],
                "count": parts[5],
                "deleted": parts[6],
                "size": parts[7],
                "prisize": parts[8]
              };
            }
          }
        }

        // Emit indexes.
        self.emit('indexes', indexes);
      }
      else {
        self.logger.error('Index error: ' + require('util').inspect(response, true, 10));
      }
    });
  };

  /**
   * Add new index (requires mappings have been created).
   */
  Search.prototype.addIndex = function addIndex(index) {
    var self = this;

    self.mappings.get(index).then(
      function (map) {
        buildNewIndex(self, self.logger, map, index);
      },
      function (error)
      {
        // Send not created event.
        self.emit('indexNotCreated', error);
      }
    );
  };

  /**
   * Remove index from the server.
   */
  Search.prototype.removeIndex = function removeIndex(index) {
    var self = this;

    self.es.indices.delete({ "index": index },
      function (err, response, status) {
        if (err) {
          self.emit('error', {
            'id' : index,
            'status': status,
            'res' : response
          });
        }
        else {
          // Emit removed status.
          self.emit('removed', index);
        }
      }
    );
  };

  // Register the plugin with the system.
  register(null, {
    'search': Search
  });
};
