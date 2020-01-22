#!/usr/bin/env python3

# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

"""
The following is a series of functions built to work with argparse
version 1.1. They exist to be able to extract arguments out from
an argparser for usage in other places. This allows Mephisto
to be able to request the correct arguments from the frontend
and construct valid argument strings from user input there.

It relies on underlying implementation details of argparse (ick)
and as such is only guaranteed stable for argparse 1.1
"""

import argparse
from typing import Optional, Dict, Any

def collect_groups_recurse(group: argparse._ArgumentGroup):
    '''
    Recursively traverse an argument group, returning
    the group and all sub-groups.

    Ignores groups without the description attribute set
    '''
    pop_list = [group]
    ret_list: List[argparse._ArgumentGroup] = []
    while len(pop_list) > 0:
        cur_group = pop_list.pop()
        ret_list.append(cur_group)
        if len(cur_group._action_groups) > 0:
            pop_list += cur_group._action_groups.copy()
    return [g for g in ret_list if g.description is not None]

def get_argument_groups(
    parser: argparse.ArgumentParser
) -> Dict[str, argparse._ArgumentGroup]:
    '''
    Extract all of the groups from an arg parser and
    return a dict mapping from group title to group
    '''
    groups: Dict[str, Any] = {'__NO_TITLE__': []}
    all_action_groups: List[argparse._ArgumentGroup] = []
    for group in parser._action_groups:
        all_action_groups += collect_groups_recurse(group)
    for group in all_action_groups:
        if group.title is None:
            groups['__NO_TITLE__'].append(group)
        else:
            groups[group.title] = group
    return groups


def get_arguments_from_group(group: argparse._ArgumentGroup) -> Dict[str, Any]:
    '''
    Extract all of the arguments from an argument group
    and return a dict mapping from argument dest to argument dict
    '''
    parsed_actions = {}
    for action in group._group_actions:
        parsed_actions[action.dest] = {
            'dest': action.dest,
            'help': action.help,
            'default': action.default,
            'type': action.type.__name__ if action.type is not None else 'str',
            'choices': action.choices,
            'option_string': action.option_strings[0]
        }
    return parsed_actions


def get_argument_group_dict(
    group: argparse._ArgumentGroup
) -> Optional[Dict[str, Any]]:
    '''
    Extract an argument group (to be ready to send it to frontend)
    '''
    if group.description is None:
        return None
    return {
        'desc': group.description,
        'args': get_arguments_from_group(group)
    }


def get_extra_argument_dict(customizable_class: Any):
    '''
    Produce the argument dict for the given customizable class
    (Blueprint, Architect, etc)
    '''
    dummy_parser = argparse.ArgumentParser
    arg_group = dummy_parser.add_argument_group()
    customizable_class.add_args_to_group(arg_group)
    return get_argument_group_dict(arg_group)
