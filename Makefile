NODE ?= node
SCRIPT := pacto-demo.mjs

.PHONY: help up up-full up-light dm squad squad-all squad-join reload down down-wipe status wipe wipe-all clean-targets

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
