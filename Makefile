NODE ?= node
SCRIPT := pacto-demo.mjs

.PHONY: help up up-full up-light up-simple up-client up-simple-client dm squad squad-all squad-join reload reload-client logs down down-wipe status wipe wipe-all clean-targets

help:
	@$(NODE) $(SCRIPT) help

# PR / BRANCH / CLIENTS / PIN come from .env. Override on the command line:
# make up PR=123 CLIENTS=3
# make up PR=0                 # pacto-app main
# make up BRANCH=feat/gov-ux-improvements CLIENTS=2
# make squad NAME=my-squad
# make reload
LAUNCH_FLAGS :=
ifdef PR
  LAUNCH_FLAGS += --pr $(PR)
endif
ifdef BRANCH
  LAUNCH_FLAGS += --branch $(BRANCH)
endif
ifdef CLIENTS
  LAUNCH_FLAGS += --clients $(CLIENTS)
endif
ifdef ENV
  LAUNCH_FLAGS += --env $(ENV)
endif
ifdef PIN
  LAUNCH_FLAGS += --pin $(PIN)
endif
ifdef NAME
  LAUNCH_FLAGS += --name $(NAME)
endif

up:
	$(NODE) $(SCRIPT) up $(LAUNCH_FLAGS)

up-full:
	$(NODE) $(SCRIPT) up --full $(LAUNCH_FLAGS)

up-light:
	$(NODE) $(SCRIPT) up --light $(LAUNCH_FLAGS)

up-simple:
	$(NODE) $(SCRIPT) up-simple $(LAUNCH_FLAGS)

# make up-client CLIENT=2  (or CLIENT= in .env)
up-client:
ifdef CLIENT
	$(NODE) $(SCRIPT) up-client $(LAUNCH_FLAGS) --client $(CLIENT)
else
	$(NODE) $(SCRIPT) up-client $(LAUNCH_FLAGS)
endif

# make up-simple-client CLIENT=2  (or CLIENT= in .env)
up-simple-client:
ifdef CLIENT
	$(NODE) $(SCRIPT) up-simple-client $(LAUNCH_FLAGS) --client $(CLIENT)
else
	$(NODE) $(SCRIPT) up-simple-client $(LAUNCH_FLAGS)
endif

dm:
	$(NODE) $(SCRIPT) dm $(LAUNCH_FLAGS)

squad:
	$(NODE) $(SCRIPT) squad $(LAUNCH_FLAGS)

squad-all:
	$(NODE) $(SCRIPT) squad --all $(LAUNCH_FLAGS)

squad-join:
	$(NODE) $(SCRIPT) squad --join $(LAUNCH_FLAGS)

reload:
	$(NODE) $(SCRIPT) reload $(LAUNCH_FLAGS)

# make reload-client CLIENT=2  (or CLIENT= in .env)
reload-client:
ifdef CLIENT
	$(NODE) $(SCRIPT) reload-client $(LAUNCH_FLAGS) --client $(CLIENT)
else
	$(NODE) $(SCRIPT) reload-client $(LAUNCH_FLAGS)
endif

# make logs LOG_CLIENT=2  (or LOG_CLIENT= in .env)
logs:
ifdef LOG_CLIENT
	$(NODE) $(SCRIPT) logs --client $(LOG_CLIENT)
else
	$(NODE) $(SCRIPT) logs
endif

down:
	$(NODE) $(SCRIPT) down

down-wipe:
	$(NODE) $(SCRIPT) down --wipe

status:
	$(NODE) $(SCRIPT) status

# make wipe CLIENT=1
wipe:
	@if [ -z "$(CLIENT)" ]; then echo "Set CLIENT=<n> (e.g. make wipe CLIENT=1)"; exit 1; fi
	$(NODE) $(SCRIPT) wipe --client $(CLIENT)

wipe-all:
	$(NODE) $(SCRIPT) wipe --all

clean-targets:
	$(NODE) $(SCRIPT) clean-targets
