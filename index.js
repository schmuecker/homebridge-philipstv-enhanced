var Service;
var Characteristic;
var request = require("request");
var pollingtoevent = require('polling-to-event');
var wol = require('wake_on_lan');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-philipstv-enhanced", "PhilipsTV", HttpStatusAccessory);
}

function HttpStatusAccessory(log, config) {
    this.log = log;
    var that = this;

    // CONFIG
    this.ip_address = config["ip_address"];
    this.name = config["name"];
    this.poll_status_interval = config["poll_status_interval"] || "0";
    this.model_year = config["model_year"] || "2018";
    this.wol_url = config["wol_url"] || "";
    this.model_year_nr = parseInt(this.model_year);
    this.set_attempt = 0;
    this.has_ssl = config["has_ssl"] || false;
	this.model_name = config["model_name"];
	this.model_version = config["model_version"];
	this.model_serial_no = config["model_serial_no"];

    // CREDENTIALS FOR API
    this.username = config["username"] || "";
    this.password = config["password"] || "";

    // CHOOSING API VERSION BY MODEL/YEAR
    switch (this.model_year_nr) {
        case 2018:
            this.api_version = 6;
            break;
        case 2017:
            this.api_version = 6;
            break;
        case 2016:
            this.api_version = 6;
            break;
        case 2015:
            this.api_version = 5;
            break;
        case 2014:
            this.api_version = 5;
            break;
        default:
            this.api_version = 1;
    }

    // CONNECTION SETTINGS
    this.protocol = this.has_ssl ? "https" : "https";
    this.portno = this.has_ssl ? "1926" : "1926";
    this.need_authentication = this.username != '' ? 1 : 0;

    this.log("Model year: " + this.model_year_nr);
    this.log("API version: " + this.api_version);

    this.state_power = true;

    // Define URL & JSON Payload for Actions

    this.base_url = this.protocol + "://" + this.ip_address + ":" + this.portno + "/" + this.api_version;
    // POWER
    this.power_url = this.base_url + "/powerstate";
    this.power_on_body = JSON.stringify({
        "powerstate": "On"
    });
    this.power_off_body = JSON.stringify({
        "powerstate": "Standby"
    });

    // VOLUME
    this.audio_url = this.base_url + "/audio/volume";

    // INPUT
    this.input_url = this.base_url + "/input/key";

    // POLLING ENABLED?
    this.interval = parseInt(this.poll_status_interval);
    this.switchHandling = "check";
    if (this.interval > 10 && this.interval < 100000) {
        this.switchHandling = "poll";
    }

    // STATUS POLLING
    if (this.switchHandling == "poll") {
        var statusemitter = pollingtoevent(function(done) {
            that.getPowerState(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_power"
        });

        statusemitter.on("statuspoll_power", function(data) {
            that.state_power = data;
            if (that.switchService) {
                that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
            }
        });

        var statusemitter_volume_level = pollingtoevent(function(done) {
            that.getVolumeLevel(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_volumeLevel"
        });

        statusemitter.on("statuspoll_volumeLevel", function(data) {
            that.state_volumeLevel = data;
            if (that.volumeService) {
                that.volumeService.getCharacteristic(Characteristic.Brightness).setValue(that.state_volumeLevel, null, "statuspoll");
            }
        });

        var statusemitter_ambilight = pollingtoevent(function(done) {
            that.getAmbilightState(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll_ambilight");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_ambilight"
        });

        statusemitter_ambilight.on("statuspoll_ambilight", function(data) {
            that.state_ambilight = data;
            if (that.ambilightService) {
                that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll_ambilight");
            }
        });

        var statusemitter_ambilight_brightness = pollingtoevent(function(done) {
            that.getAmbilightBrightness(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_ambilight_brightness"
        });

        statusemitter_ambilight_brightness.on("statuspoll_ambilight_brightness", function(data) {
            that.state_ambilight_brightness = data;
            if (that.ambilightService) {
                that.ambilightService.getCharacteristic(Characteristic.Brightness).setValue(that.state_ambilight_brightness, null, "statuspoll");
            }
        }); 
    }

    // AMBILIGHT
	this.status_url_ambilight = this.base_url + "/ambilight/power";

	this.on_url_ambilight = this.base_url + "/ambilight/currentconfiguration";
	this.on_body_ambilight = JSON.stringify({
		"styleName": "FOLLOW_VIDEO",
		"isExpert": false,
		"menuSetting": "NATURAL"
	});

	this.off_url_ambilight = this.status_url_ambilight
	this.off_body_ambilight = JSON.stringify({
		"power": "Off"
    });
    
    // AMBILIGHT
    this.ambilight_status_url = this.base_url + "/menuitems/settings/current";
    this.ambilight_brightness_body = JSON.stringify({"nodes":[{"nodeid":2131230769}]});
    this.ambilight_config_url = this.base_url + "/menuitems/settings/update";
}

/////////////////////////////

HttpStatusAccessory.prototype = {

	// Sometime the API fail, all calls should use a retry method, not used yet but goal is to replace all the XLoop function by this generic one
    httpRequest_with_retry: function(url, body, method, need_authentication, retry_count, callback) {
        this.httpRequest(url, body, method, need_authentication, function(error, response, responseBody) {
            if (error) {
                if (retry_count > 0) {
                    this.log('Got error, will retry: ', retry_count, ' time(s)');
                    this.httpRequest_with_retry(url, body, method, need_authentication, retry_count - 1, function(err) {
                        callback(err);
                    });
                } else {
                    this.log('Request failed: %s', error.message);
                    callback(new Error("Request attempt failed"));
                }
            } else {
                this.log('succeeded - answer: %s', responseBody);
                callback(null, response, responseBody);
            }
        }.bind(this));
    },

    httpRequest: function(url, body, method, need_authentication, callback) {
        var options = {
            url: url,
            body: body,
            method: method,
            rejectUnauthorized: false,
            timeout: 1000
        };

        // EXTRA CONNECTION SETTINGS FOR API V6 (HTTP DIGEST)
        if (need_authentication) {
            options.followAllRedirects = true;
            options.forever = true;
            options.auth = {
                user: this.username,
                pass: this.password,
                sendImmediately: false
            }
        }

        req = request(options,
            function(error, response, body) {
                callback(error, response, body)
        	}
        );
    },

    wolRequest: function(url, callback) {
        this.log('calling WOL with URL %s', url);
        if (!url) {
            callback(null, "EMPTY");
            return;
        }
        if (url.substring(0, 3).toUpperCase() == "WOL") {
            //Wake on lan request
            var macAddress = url.replace(/^WOL[:]?[\/]?[\/]?/ig, "");
            this.log("Excuting WakeOnLan request to " + macAddress);
            wol.wake(macAddress, function(error) {
                if (error) {
                    callback(error);
                } else {
                    callback(null, "OK");
                }
            });
        } else {
            if (url.length > 3) {
                callback(new Error("Unsupported protocol: ", "ERROR"));
            } else {
                callback(null, "EMPTY");
            }
        }
    },

    // POWER FUNCTIONS -----------------------------------------------------------------------------------------------------------
    setPowerStateLoop: function(nCount, url, body, powerState, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setPowerStateLoop - powerstate attempt, attempt id: ', nCount - 1);
                    that.setPowerStateLoop(nCount - 1, url, body, powerState, function(err, state_power) {
                        callback(err, state_power);
                    });
                } else {
                    that.log('setPowerStateLoop - failed: %s', error.message);
                    powerState = false;
                    callback(new Error("HTTP attempt failed"), powerState);
                }
            } else {
                that.log('setPowerStateLoop - Succeeded - current state: %s', powerState);
                callback(null, powerState);
            }
        });
    },

    setPowerState: function(powerState, callback, context) {
        var url = this.power_url;
        var body;
        var that = this;

		this.log.debug("Entering %s with context: %s and target value: %s", arguments.callee.name, context, powerState);

        if (context && context == "statuspoll") {
				callback(null, powerState);
				return;
        }

        this.set_attempt = this.set_attempt + 1;

        if (powerState) {
            if (this.model_year_nr <= 2013) {
                this.log("Power On is not possible for model_year before 2014.");
                callback(new Error("Power On is not possible for model_year before 2014."));
            }
            body = this.power_on_body;
            this.log("setPowerState - Will power on");
			// If Mac Addr for WOL is set
			if (this.wol_url) {
				that.log('setPowerState - Sending WOL');
				this.wolRequest(this.wol_url, function(error, response) {
					that.log('setPowerState - WOL callback response: %s', response);
					that.log('setPowerState - powerstate attempt, attempt id: ', 8);
					//execute the callback immediately, to give control back to homekit
					callback(error, that.state_power);
					that.setPowerStateLoop(8, url, body, powerState, function(error, state_power) {
						that.state_power = state_power;
						if (error) {
							that.state_power = false;
							that.log("setPowerStateLoop - ERROR: %s", error);
							if (that.switchService) {
								that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
							}
						}
					});
				}.bind(this));
			}
        } else {
            body = this.power_off_body;
            this.log("setPowerState - Will power off");
            that.setPowerStateLoop(0, url, body, powerState, function(error, state_power) {
                that.state_power = state_power;
                if (error) {
                    that.state_power = false;
                    that.log("setPowerStateLoop - ERROR: %s", error);
                }
                if (that.switchService) {
                    that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
                }
                if (that.ambilightService) {
                    that.state_ambilight = false;
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll");
                }
                 if (that.volumeService) {
                    that.state_volume = false;
                    that.volumeService.getCharacteristic(Characteristic.On).setValue(that.state_volume, null, "statuspoll");
                }
                callback(error, that.state_power);
            }.bind(this));
        }
    },

    getPowerState: function(callback, context) {
        var that = this;
        var url = this.power_url;

        that.log("getPowerState with : %s", url);
   		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_power);
        //if context is statuspoll, then we need to request the actual value else we return the cached value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_power);
            return;
        }

        this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_power;
            var fctname = "getPowerState";
            if (error) {
				that.log("getPowerState with : %s", url);
                that.log('%s - ERROR: %s', fctname, error.message);
                that.state_power = false;
            } else {
                if (responseBody) {
                    var responseBodyParsed;
                    try {
                        responseBodyParsed = JSON.parse(responseBody);
                        if (responseBodyParsed && responseBodyParsed.powerstate) {
                        	tResp = (responseBodyParsed.powerstate == "On") ? 1 : 0;
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating state", fctname, responseBody);
						}
                    } catch (e) {
						that.log("getPowerState with : %s", url);
                        that.log("%s - Got non JSON answer - not updating state: '%s'", fctname, responseBody);
			responseBodyParsed = false;
                    }
                }
                if (that.state_power != tResp) {
                    that.log('%s - Level changed to: %s', fctname, tResp);
	                that.state_power = tResp;
                }
            }
            callback(null, that.state_power);
        }.bind(this));
    },

    /// Send a key  -----------------------------------------------------------------------------------------------------------
    sendKey: function(key, callback, context) {
        this.log("Entering %s with context: %s and target value: %s", arguments.callee.name, context, key);

        var keyName = null;
        if (key == Characteristic.RemoteKey.ARROW_UP) {
            keyName = "CursorUp";
        } else if (key == Characteristic.RemoteKey.ARROW_LEFT) {
            keyName = "CursorLeft";
        } else if (key == Characteristic.RemoteKey.ARROW_RIGHT) {
            keyName = "CursorRight";
        } else if (key == Characteristic.RemoteKey.ARROW_DOWN) {
            keyName = "CursorDown";
        } else if (key == Characteristic.RemoteKey.BACK) {
            keyName = "Back";
        } else if (key == Characteristic.RemoteKey.EXIT) {
            keyName = "Exit";
        } else if (key == Characteristic.RemoteKey.INFORMATION) {
            keyName = "Home";
        } else if (key == Characteristic.RemoteKey.SELECT) {
            keyName = "Confirm";
        } else if (key == Characteristic.RemoteKey.PLAY_PAUSE) {
            keyName = "PlayPause";
        } else if (key == 'VolumeUp') {
            keyName = "VolumeUp";
        } else if (key == 'VolumeDown') {
            keyName = "VolumeDown";
        }
        if (keyName != null) {
            url = this.input_url;
            body = JSON.stringify({"key": keyName});
            this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
                if (error) {
                    this.log('sendKey - error: ', error.message);
                } else {
                    this.log('sendKey - succeeded - %s', key);
                }
            }.bind(this));
        }
        callback(null, null);
    },

    // Volume

    setVolumeLevelLoop: function(nCount, url, body, volumeLevel, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setVolumeLevelLoop - attempt, attempt id: ', nCount - 1);
                    that.setVolumeLevelLoop(nCount - 1, url, body, volumeLevel, function(err, state) {
                        callback(err, state);
                    });
                } else {
                    that.log('setVolumeLevelLoop - failed: %s', error.message);
                    volumeLevel = false;
                    callback(new Error("HTTP attempt failed"), volumeLevel);
                }
            } else {
                that.log('setVolumeLevelLoop - succeeded - current level: %s', volumeLevel);
                callback(null, volumeLevel);
            }
        });
    },

    setVolumeLevel: function(volumeLevel, callback, context) {
        var TV_Adjusted_volumeLevel = Math.round(volumeLevel / 4);
        var url = this.audio_url;
        var body = JSON.stringify({"current": TV_Adjusted_volumeLevel});
        var that = this;

		this.log.debug("Entering %s with context: %s and target value: %s", arguments.callee.name, context, volumeLevel);

        //if context is statuspoll, then we need to ensure that we do not set the actual value
        if (context && context == "statuspoll") {
            callback(null, volumeLevel);
            return;
        }

        this.set_attempt = this.set_attempt + 1;

        // volumeLevel will be in %, let's convert to reasonable values accepted by TV
        that.setVolumeLevelLoop(0, url, body, volumeLevel, function(error, state) {
            that.state_volumeLevel = volumeLevel;
            if (error) {
                that.state_volumeLevel = false;
                that.log("setVolumeState - ERROR: %s", error);
                if (that.volumeService) {
                    that.volumeService.getCharacteristic(Characteristic.On).setValue(that.state_volumeLevel, null, "statuspoll");
                }
            }
            callback(error, that.state_volumeLevel);
        }.bind(this));
    },

    getVolumeLevel: function(callback, context) {
        var that = this;
        var url = this.audio_url;

   		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_volumeLevel);
        //if context is statuspoll, then we need to request the actual value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_volumeLevel);
            return;
        }
        if (!this.state_power) {
                callback(null, 0);
                return;
        }

        this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_volumeLevel;
            var fctname = "getVolumeLevel";
            if (error) {
                that.log('%s - ERROR: %s', fctname, error.message);
            } else {
                if (responseBody) {
                    var responseBodyParsed;
                    try {
						responseBodyParsed = JSON.parse(responseBody);
						if (responseBodyParsed) {
							tResp = Math.round(4 * responseBodyParsed.current);
							that.log.debug('%s - got answer %s', fctname, tResp);
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating level", fctname, responseBody);
						}
					 } catch (e) {
                        that.log("%s - Got non JSON answer - not updating level: '%s'", fctname, responseBody);
                    }
                }
				if (that.state_volumeLevel != tResp) {
                    that.log('%s - Level changed to: %s', fctname, tResp);
	                that.state_volumeLevel = tResp;
				}
            }
            callback(null, that.state_volumeLevel);
        }.bind(this));
    },

   /// Next input  -----------------------------------------------------------------------------------------------------------
    setNextInput: function(inputState, callback, context)
    {
        this.log.debug("Entering %s with context: %s and target value: %s", arguments.callee.name, context, inputState);

        url = this.input_url;
        body = JSON.stringify({"key": "Source"});
        this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
        {
            if (error)
            {
                this.log('setNextInput - error: ', error.message);
            }
            else
            {
                this.log('Source - succeeded - current state: %s', inputState);

                setTimeout(function ()
                {
                    body = JSON.stringify({"key": "CursorDown"});

                    this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
                    {
                        if (error)
                        {
                             this.log('setNextInput - error: ', error.message);
                        }
                        else
                        {
                            this.log('Down - succeeded - current state: %s', inputState);
                            setTimeout(function()
                            {
                                body = JSON.stringify({"key": "Confirm"});

                                this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
                                {
                                    if (error)
                                    {
                                        this.log('setNextInput - error: ', error.message);
                                    }
                                    else
                                    {
                                        this.log.info("Source change completed");
                                    }
                                }.bind(this));
                            }.bind(this), 800);
                        }
                    }.bind(this));
				}.bind(this), 800);
            }
        }.bind(this));
        callback(null, null);
    },

    getNextInput: function(callback, context) {
        callback(null, null);
    },

   /// Previous input  -----------------------------------------------------------------------------------------------------------
    setPreviousInput: function(inputState, callback, context)
    {
        this.log.debug("Entering %s with context: %s and target value: %s", arguments.callee.name, context, inputState);

        url = this.input_url;
        body = JSON.stringify({"key": "Source"});
        this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
        {
            if (error)
            {
                this.log('setPreviousInput - error: ', error.message);
            }
            else
            {
                this.log('Source - succeeded - current state: %s', inputState);

                setTimeout(function ()
                {
                    body = JSON.stringify({"key": "CursorUp"});

                    this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
                    {
                        if (error)
                        {
                             this.log('setPreviousInput - error: ', error.message);
                        }
                        else
                        {
                            this.log('Down - succeeded - current state: %s', inputState);
                            setTimeout(function()
                            {
                                body = JSON.stringify({"key": "Confirm"});

                                this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody)
                                {
                                    if (error)
                                    {
                                        this.log('setPreviousInput - error: ', error.message);
                                    }
                                    else
                                    {
                                        this.log.info("Source change completed");
                                    }
                                }.bind(this));
                            }.bind(this), 800);
                        }
                    }.bind(this));
				}.bind(this), 800);
            }
        }.bind(this));
        callback(null, null);
    },

    getPreviousInput: function(callback, context) {
        callback(null, null);
    },

    identify: function(callback) {
        this.log("Identify requested!");
        callback(); // success
    },

    setAmbilightState: function(ambilightState, callback, context) {
		var that = this;

		//if context is statuspoll, then we need to ensure that we do not set the actual value
		if (context && context == "statuspoll") {
			callback(null, ambilightState);
			return;
		}

        var url = (ambilightState) ? this.on_url_ambilight : this.off_url_ambilight;
		var body = (ambilightState) ? this.on_body_ambilight : this.off_body_ambilight;
        that.log("setAmbilightState - setting state to %s", ambilightState ? "ON" : "OFF");
        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) 
        {
            if (error) {
				that.log('setAmbilightState - failed: %s', error.message);
				callback(new Error("HTTP attempt failed"), false);
            } else {
                that.log('setAmbilightState - succeeded - current state: %s', ambilightState);
                callback(null, ambilightState);
            }
        });
	},

	getAmbilightState: function(callback, context) {
		var that = this;
		//if context is not statuspoll, then we need to get the stored value
		if ((!context || context != "statuspoll_ambilight") && this.switchHandling == "poll") {
			callback(null, this.state_ambilight);
			return;
		}
        that.httpRequest(this.status_url_ambilight, "", "GET", this.need_authentication, function(error, response, responseBody) 
        {
			var powerState = 0;
			if (!error) {
				if (responseBody) {
					var responseBodyParsed = JSON.parse(responseBody);
					if (responseBodyParsed && responseBodyParsed.power) {
                        powerState = (responseBodyParsed.power == "On") ? 1 : 0;
					}
				}
			} else {
				that.log('getAmbilightState - actual mode - failed: %s', error.message);
			}

			if (that.state_ambilight != powerState) {
				that.log('getAmbilightState - statechange to: %s', powerState);
			}

			that.state_ambilight = powerState;
			callback(null, powerState);
		}.bind(this));
    },

    setAmbilightBrightnessLoop: function(nCount, url, body, ambilightLevel, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setAmbilightStateLoop - attempt, attempt id: ', nCount - 1);
                    that.setAmbilightBrightnessLoop(nCount - 1, url, body, ambilightLevel, function(err, state) {
                        callback(err, state);
                    });
                } else {
                    that.log('setAmbilightBrightnessLoop - failed: %s', error.message);
                    ambilightLevel = false;
                    callback(new Error("HTTP attempt failed"), ambilightLevel);
                }
            } else {
                that.log('setAmbilightBrightnessLoop - succeeded - current state: %s', ambilightLevel);
                callback(null, ambilightLevel);
            }
        });
    },

    setAmbilightBrightness: function(ambilightLevel, callback, context) {
		var TV_Adjusted_ambilightLevel = Math.round(ambilightLevel / 10);
        var url = this.ambilight_config_url;
        var body = JSON.stringify({"value":{"Nodeid":2131230769,"Controllable":true,"Available":true,"data":{"value":TV_Adjusted_ambilightLevel}}});
        var that = this;

 		this.log.debug("Entering setAmbilightBrightness with context: %s and requested value: %s", context, ambilightLevel);
        //if context is statuspoll, then we need to ensure that we do not set the actual value
        if (context && context == "statuspoll") {
            callback(null, ambilightLevel);
            return;
        }

        this.set_attempt = this.set_attempt + 1;

        that.setAmbilightBrightnessLoop(0, url, body, ambilightLevel, function(error, state) {
            that.state_ambilightLevel = ambilightLevel;
            if (error) {
                that.state_ambilightLevel = false;
                that.log("setAmbilightBrightness - ERROR: %s", error);
                if (that.ambilightService) {
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilightLevel, null, "statuspoll");
                }
            }
            callback(error, that.state_ambilightLevel);
        }.bind(this));
    },

    getAmbilightBrightness: function(callback, context) {
        var that = this;
        var url = this.ambilight_status_url;
        var body = this.ambilight_brightness_body;

		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_ambilightLevel);
        //if context is statuspoll, then we need to request the actual value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_ambilightLevel);
            return;
        }
        if (!this.state_power) {
                callback(null, 0);
                return;
        }

        this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_ambilightLevel;
            var fctname = "getAmbilightBrightness";
            if (error) {
                that.log('%s - ERROR: %s', fctname, error.message);
            } else {
                if (responseBody) {
	                var responseBodyParsed;
                    try {
						responseBodyParsed = JSON.parse(responseBody);
						if (responseBodyParsed && responseBodyParsed.values[0].value.data) {
							tResp = 10*responseBodyParsed.values[0].value.data.value;
							that.log.debug('%s - got answer %s', fctname, tResp);
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating level", fctname, responseBody);
						}
					} catch (e) {
                        that.log("%s - Got non JSON answer - not updating level: '%s'", fctname, responseBody);
                    }
                }
                if (that.state_ambilightLevel != tResp) {
                    that.log('%s - Level changed to: %s', fctname, tResp);
	                that.state_ambilightLevel = tResp;
                }
            }
            callback(null, that.state_ambilightLevel);
        }.bind(this));
    },
    
    getServices: function()
    {

        var informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, 'Philips')
            .setCharacteristic(Characteristic.Model, this.model_name)
			.setCharacteristic(Characteristic.FirmwareRevision, this.model_version)
			.setCharacteristic(Characteristic.SerialNumber, this.model_serial_no);


        // this.televisionService = new Service.Television();
	    // this.televisionService
        //     .setCharacteristic(Characteristic.ConfiguredName, "TV " + this.name);

        // POWER
        // this.televisionService
        //     .getCharacteristic(Characteristic.Active)
        //     .on('get', this.getPowerState.bind(this))
        //     .on('set', this.setPowerState.bind(this));

        // this.televisionService
        //     .setCharacteristic(
        //          Characteristic.SleepDiscoveryMode,
        //          Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
        //     );

        // this.televisionService
        //     .getCharacteristic(Characteristic.RemoteKey)
        //     .on('set', this.sendKey.bind(this));

        this.switchService = new Service.Switch(this.name + " Power");
        this.switchService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));

        // Volume
        // this.volumeService = new Service.Lightbulb(this.name + " Volume", '0b');

        // this.volumeService
        //     .getCharacteristic(Characteristic.Brightness)
        //     .on('get', this.getVolumeLevel.bind(this))
        //     .on('set', this.setVolumeLevel.bind(this));

        // // Next input
        // this.NextInputService = new Service.Switch(this.name + " Next input", '0b');
        // this.NextInputService
        //     .getCharacteristic(Characteristic.On)
        //     .on('get', this.getNextInput.bind(this))
        //     .on('set', this.setNextInput.bind(this));

        // // Previous input
        // this.PreviousInputService = new Service.Switch(this.name + " Previous input", '0c');
        // this.PreviousInputService
        //     .getCharacteristic(Characteristic.On)
        //     .on('get', this.getPreviousInput.bind(this))
        //     .on('set', this.setPreviousInput.bind(this));
        
        // AMBILIGHT
        this.ambilightService = new Service.Lightbulb(this.name + " Ambilight", '0e');
        this.ambilightService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getAmbilightState.bind(this))
            .on('set', this.setAmbilightState.bind(this));

        this.ambilightService
            .getCharacteristic(Characteristic.Brightness)
            .on('get', this.getAmbilightBrightness.bind(this))
            .on('set', this.setAmbilightBrightness.bind(this));

        return [informationService, this.switchService, this.ambilightService];
    }
};
